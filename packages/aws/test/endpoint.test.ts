import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vitest";
import * as Credentials from "../src/credentials-service.ts";
import * as Endpoint from "../src/endpoint.ts";
import * as Presign from "../src/presign.ts";
import * as Region from "../src/region.ts";
import * as SESv2 from "../src/services/sesv2.ts";

describe("service endpoint resolution", () => {
  /**
   * Routes a couple of services at dedicated addresses and everything else
   * at a catch-all — the shape a local emulator or a private endpoint fleet
   * takes. Keys are SDK service IDs verbatim (`aws.api#service` sdkId), so
   * SES and SESv2 stay independently routable even though both sign as
   * `ses`.
   */
  const perService: Record<string, string> = {
    SESv2: "http://service-a.test:4600",
    DynamoDB: "http://service-b.test:8000",
  };
  const catchAll = "http://catch-all.test:4566";

  const endpoints = {
    resolve: (service: string) => perService[service] ?? catchAll,
  } satisfies Endpoint.ServiceEndpointResolver;

  it("routes every service through the resolver", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        for (const [service, endpoint] of Object.entries(perService)) {
          expect(yield* Endpoint.resolve(service)).toBe(endpoint);
        }
        // SES (v1) is NOT routed with SESv2: the key is the SDK service ID,
        // not the shared `ses` signing name.
        for (const service of ["SES", "S3", "not-routed-anywhere"]) {
          expect(yield* Endpoint.resolve(service)).toBe(catchAll);
        }
      }).pipe(Effect.provideService(Endpoint.ServiceEndpoint, endpoints)),
    );
  });

  it("keeps an explicit operation endpoint authoritative", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* Endpoint.resolve("SESv2")).toBe("http://operation.test");
        expect(yield* Endpoint.resolve("SQS")).toBe("http://operation.test");
      }).pipe(
        Effect.provideService(Endpoint.ServiceEndpoint, endpoints),
        Effect.provideService(Endpoint.Endpoint, Effect.succeed("http://operation.test")),
      ),
    );
  });

  it("falls back to the resolver when the override resolves undefined", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* Endpoint.resolve("SESv2")).toBe("http://service-a.test:4600");
      }).pipe(
        Effect.provideService(Endpoint.ServiceEndpoint, endpoints),
        Effect.provideService(Endpoint.Endpoint, Effect.succeed(undefined)),
      ),
    );
  });

  it("leaves cloud endpoint selection available without a resolver", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* Endpoint.resolve("SESv2")).toBeUndefined();
      }),
    );
  });

  it("routes generated operations by SDK service ID", async () => {
    let requested: URL | undefined;
    const client = HttpClient.make((request, url) => {
      requested = url;
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response("{}", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
    });

    await Effect.runPromise(
      SESv2.getAccount({}).pipe(
        Effect.provideService(Endpoint.ServiceEndpoint, {
          resolve: (service) => (service === "SESv2" ? "http://ses-local.test:4600" : undefined),
        }),
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provide(Credentials.mock),
      ),
    );

    expect(requested?.origin).toBe("http://ses-local.test:4600");
  });

  it("falls through to generated endpoint rules", async () => {
    let requested: URL | undefined;
    const client = HttpClient.make((request, url) => {
      requested = url;
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response("{}", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
    });

    await Effect.runPromise(
      SESv2.getAccount({}).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provide(Credentials.mock),
      ),
    );

    expect(requested?.origin).toBe("https://email.us-east-1.amazonaws.com");
  });

  it("resolves routing and lazy credentials in each calling scope", async () => {
    const requests: Array<{
      origin: string;
      authorization: string | undefined;
    }> = [];
    const client = HttpClient.make((request, url) => {
      requests.push({
        origin: url.origin,
        authorization: request.headers.authorization,
      });
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response("{}", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
    });
    const base = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* yield* Credentials.Credentials;
      }).pipe(Effect.provide(Credentials.mock)),
    );
    let credentialReads = 0;
    const credentials = Effect.sync(() => ({
      ...base,
      accessKeyId: Redacted.make(`request-${++credentialReads}`),
    }));
    const operation = SESv2.getAccount({});

    for (const endpoint of ["http://first.test:4600", "http://second.test:4600"]) {
      await Effect.runPromise(
        operation.pipe(
          Effect.provideService(Endpoint.ServiceEndpoint, {
            resolve: (service) => (service === "SESv2" ? endpoint : undefined),
          }),
          Effect.provideService(Credentials.Credentials, credentials),
          Effect.provideService(HttpClient.HttpClient, client),
        ),
      );
    }

    expect(requests.map((request) => request.origin)).toEqual([
      "http://first.test:4600",
      "http://second.test:4600",
    ]);
    expect(credentialReads).toBe(2);
    expect(requests[0]?.authorization).toContain("Credential=request-1/");
    expect(requests[1]?.authorization).toContain("Credential=request-2/");
  });

  it("keeps the operation endpoint authoritative in generated operations", async () => {
    let requested: URL | undefined;
    const client = HttpClient.make((request, url) => {
      requested = url;
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response("{}", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
    });

    await Effect.runPromise(
      SESv2.getAccount({}).pipe(
        Effect.provideService(Endpoint.ServiceEndpoint, endpoints),
        Effect.provide(Endpoint.of("http://explicit.test:4700")),
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provide(Credentials.mock),
      ),
    );

    expect(requested?.origin).toBe("http://explicit.test:4700");
  });

  it("uses the S3 service endpoint when presigning", async () => {
    const url = await Effect.runPromise(
      Presign.presignS3Url({
        bucket: "uploads",
        key: "reports/quarter 1!'()*.csv",
        region: "us-east-1",
        datetime: "20260824T000000Z",
      }).pipe(
        Effect.provideService(Endpoint.ServiceEndpoint, {
          resolve: (service) => (service === "S3" ? "http://s3-local.test:9000" : undefined),
        }),
        Effect.provide(Credentials.mock),
        Effect.provide(Region.of("us-east-1")),
      ),
    );

    const presigned = new URL(url);
    expect(presigned.origin).toBe("http://s3-local.test:9000");
    expect(presigned.pathname).toBe("/uploads/reports/quarter%201%21%27%28%29%2A.csv");
    expect(presigned.searchParams.get("X-Amz-Credential")).toContain("/s3/aws4_request");
  });
});
