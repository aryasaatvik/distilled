import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import * as Credentials from "../src/credentials.browser.ts";
import * as Endpoint from "../src/endpoint.ts";
import { createBucket, headBucket } from "../src/services/s3.ts";

const customEndpoint = "http://floci.test:4566";

const captureRequest = (
  requests: Array<{ readonly method: string; readonly url: string }>,
) =>
  HttpClient.make((request) => {
    requests.push({ method: request.method, url: request.url });
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(null, {
          status: 200,
          headers: { "content-length": "0" },
        }),
      ),
    );
  });

const provideCustomEndpoint = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(Endpoint.Endpoint, Effect.succeed(customEndpoint)),
    Effect.provide(Credentials.mock),
  );

describe("S3 custom endpoints", () => {
  it("uses path-style addressing for HeadBucket", async () => {
    const requests: Array<{ readonly method: string; readonly url: string }> =
      [];

    await Effect.runPromise(
      headBucket({ Bucket: "local-assets" }).pipe(
        Effect.provideService(HttpClient.HttpClient, captureRequest(requests)),
        provideCustomEndpoint,
        Effect.asVoid,
        Effect.orDie,
      ),
    );

    expect(requests).toEqual([
      { method: "HEAD", url: `${customEndpoint}/local-assets` },
    ]);
  });

  it("uses path-style addressing for CreateBucket", async () => {
    const requests: Array<{ readonly method: string; readonly url: string }> =
      [];

    await Effect.runPromise(
      createBucket({ Bucket: "local-artifacts" }).pipe(
        Effect.provideService(HttpClient.HttpClient, captureRequest(requests)),
        provideCustomEndpoint,
        Effect.asVoid,
        Effect.orDie,
      ),
    );

    expect(requests).toEqual([
      { method: "PUT", url: `${customEndpoint}/local-artifacts` },
    ]);
  });
});
