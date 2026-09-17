import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

export class Endpoint extends Context.Service<
  Endpoint,
  Effect.Effect<string | undefined>
>()("AWS::Endpoint") {}

/**
 * Resolves endpoints by the AWS SDK service ID exactly as it appears in the
 * model's `aws.api#service` trait — for example `"S3"`, `"DynamoDB"`,
 * `"SESv2"`, and `"S3 Control"`.
 */
export interface ServiceEndpointResolver {
  readonly resolve: (service: string) => string | undefined;
}

/**
 * Endpoint configuration accepted from an AWS runtime environment.
 *
 * A per-service resolver complements an operation-scoped {@link Endpoint}:
 * the operation override always takes precedence.
 */
export interface AWSEnvironmentShape {
  readonly serviceEndpoints?: ServiceEndpointResolver;
}

export class ServiceEndpoint extends Context.Service<
  ServiceEndpoint,
  ServiceEndpointResolver
>()("AWS::ServiceEndpoint") {}

/**
 * `AWS_ENDPOINT_URL` — the LocalStack-standard endpoint override that local
 * emulators (floci, LocalStack) inject into runtime environments (e.g.
 * Lambda containers). Resolves `undefined` when unset, so the SDK's
 * default endpoint resolver runs.
 */
export const fromEnvironment = Config.String("AWS_ENDPOINT_URL").pipe(
  Config.option,
  Effect.map(Option.getOrUndefined),
);

/** Override the endpoint with whatever the environment names, if anything. */
export const fromEnv = () =>
  Layer.succeed(Endpoint, fromEnvironment.pipe(Effect.orDie));

/** Override the endpoint for a scope, e.g. `Endpoint.of("http://localhost:4566")`. */
export const of = (endpoint: string) =>
  Layer.succeed(Endpoint, Effect.succeed(endpoint));

/**
 * Resolve the endpoint for one AWS SDK service ID. An explicit
 * operation-scoped {@link Endpoint} wins, followed by the optional
 * {@link ServiceEndpoint} resolver. Returning `undefined` leaves endpoint
 * selection to the generated Smithy rules.
 */
export const resolve = Effect.fnUntraced(function* (service: string) {
  const explicit = yield* yield* Effect.serviceOption(Endpoint).pipe(
    Effect.map(Option.getOrElse(() => Effect.undefined)),
  );
  if (explicit !== undefined) return explicit;

  const resolver = yield* Effect.serviceOption(ServiceEndpoint).pipe(
    Effect.map(Option.getOrUndefined),
  );
  return resolver?.resolve(service);
});
