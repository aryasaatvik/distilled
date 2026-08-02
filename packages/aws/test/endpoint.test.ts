import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as Endpoint from "../src/endpoint.ts";

describe("service endpoint resolution", () => {
  const endpoints = {
    resolve: (service: string) =>
      service === "ses"
        ? "http://samva-emulate.test/ses"
        : "http://floci.test:4566",
  } satisfies Endpoint.ServiceEndpointResolver;

  it.effect("uses a service override before the global local endpoint", () =>
    Effect.gen(function* () {
      expect(yield* Endpoint.resolve("ses")).toBe(
        "http://samva-emulate.test/ses",
      );
      expect(yield* Endpoint.resolve("sqs")).toBe("http://floci.test:4566");
      expect(yield* Endpoint.resolve("not-supported-by-floci")).toBe(
        "http://floci.test:4566",
      );
    }).pipe(
      Effect.provideService(
        Endpoint.ServiceEndpoint,
        Effect.succeed(endpoints),
      ),
    ),
  );

  it.effect("keeps an explicit operation endpoint authoritative", () =>
    Effect.gen(function* () {
      expect(yield* Endpoint.resolve("ses")).toBe("http://operation.test");
    }).pipe(
      Effect.provideService(
        Endpoint.ServiceEndpoint,
        Effect.succeed(endpoints),
      ),
      Effect.provideService(
        Endpoint.Endpoint,
        Effect.succeed("http://operation.test"),
      ),
    ),
  );

  it.effect(
    "leaves cloud endpoint selection available without a resolver",
    () =>
      Effect.gen(function* () {
        expect(yield* Endpoint.resolve("ses")).toBeUndefined();
      }),
  );
});
