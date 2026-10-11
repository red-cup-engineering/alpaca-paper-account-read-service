import { createBrokerageAuthorityCustody } from "@red-cup-engineering/brokerage-authority-custody-service";
import { createAlpacaAdapter } from "@red-cup-engineering/pluggable-venue-adapter-service/alpaca";
import { EMPTY_WITNESS_ROOT, identifyJsonSemanticContent } from "@red-cup-engineering/semantic-content-identify-service";

const semanticId = (value) => identifyJsonSemanticContent({ objectKind: "brokerage.alpaca-paper-account-read.record", value, witnessRoot: EMPTY_WITNESS_ROOT }).id;
const canonical = (value) => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
const identify = (body) => ({ id: semanticId(body), ...body });
const secretKey = /(?:authorization|api[-_]?key|api[-_]?secret|secret|token|password|private[-_]?key)/iu;
const scrub = (value, seen = new Set()) => !value || typeof value !== "object" ? value : seen.has(value) ? null : (seen.add(value), Array.isArray(value) ? value.map((x) => scrub(x, seen)) : Object.fromEntries(Object.entries(value).filter(([key]) => !secretKey.test(key)).map(([key, member]) => [key, scrub(member, seen)])));
const valid = (value, name) => { if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name}-required`); return value; };
const PAPER_ORIGIN = "https://paper-api.alpaca.markets";

export function createPaperFetchTransport(fetchImpl = fetch) {
  if (typeof fetchImpl !== "function") throw new TypeError("paper-fetch-required");
  return async ({ method, url, headers, body }) => {
    const parsed = new URL(url);
    if (parsed.origin !== PAPER_ORIGIN || !["GET"].includes(method) || body !== undefined) throw new TypeError("paper-read-transport-operation-refused");
    const response = await fetchImpl(url, { method, headers });
    const contentType = response.headers?.get?.("content-type") ?? "";
    if (!/application\/json/iu.test(contentType)) throw new TypeError("paper-read-json-response-required");
    return Object.freeze({ status: response.status, headers: { "x-request-id": response.headers?.get?.("x-request-id") ?? null }, body: await response.json() });
  };
}

export async function createAlpacaPaperAccountReadService(env = process.env, dependencies = {}) {
  valid(env.ALPACA_ACCOUNT_ESTHER_PAPER_TRADING_KEY, "ALPACA_ACCOUNT_ESTHER_PAPER_TRADING_KEY"); valid(env.ALPACA_ACCOUNT_ESTHER_PAPER_TRADING_SECRET, "ALPACA_ACCOUNT_ESTHER_PAPER_TRADING_SECRET");
  const accountAlias = dependencies.accountAlias ?? "alpaca-paper:esther", now = dependencies.now ?? (() => new Date().toISOString());
  const resolveObservationAuthorization = dependencies.resolveObservationAuthorization;
  if (typeof resolveObservationAuthorization !== "function") throw new TypeError("paper-observation-authorization-resolver-required");
  if (!dependencies.authorityCustody || !["store", "retrieve", "revoke"].every((method) => typeof dependencies.authorityCustody[method] === "function")) throw new TypeError("authority-custody-actuator-required");
  const admitted = await dependencies.authorityCustody.store({ provider: "alpaca", subject: dependencies.principal ?? "urn:principal:esther-davis", attributes: { kind: "alpaca-trading-api-key", venue: "alpaca-trading-paper", environment: "paper", accountAlias }, secret: { kind: "alpaca-trading-api-key", principal: dependencies.principal ?? "urn:principal:esther-davis", venue: "alpaca-trading-paper", environment: "paper", accountReference: accountAlias, credential: { apiKeyId: env.ALPACA_ACCOUNT_ESTHER_PAPER_TRADING_KEY, apiSecret: env.ALPACA_ACCOUNT_ESTHER_PAPER_TRADING_SECRET } } });
  const custody = dependencies.custody ?? createBrokerageAuthorityCustody({ authorityCustody: dependencies.authorityCustody, transport: dependencies.transport ?? createPaperFetchTransport(dependencies.fetchImpl), resolvePaperObservationAuthorization: resolveObservationAuthorization, clock: now });
  const credential = admitted.reference;
  const adapter = dependencies.adapter ?? createAlpacaAdapter({ product: "alpaca-trading-paper", baseUrl: `${PAPER_ORIGIN}/`, authorityClient: custody });
  const recordObservation = dependencies.recordObservation;
  if (typeof recordObservation !== "function") throw new TypeError("independent-paper-observation-recorder-required");
  const preflight = async ({ authorizationReference, at = now() }) => {
    const authorization = await resolveObservationAuthorization(authorizationReference);
    const observedAt = Date.parse(at), validUntil = Date.parse(authorization?.validUntil);
    if (!Number.isFinite(observedAt) || !Number.isFinite(validUntil) || authorization?.id !== authorizationReference || authorization.type !== "PrincipalPaperAccountObservationAuthorization" || authorization.revoked !== false || authorization.credentialReference !== credential || authorization.accountAlias !== accountAlias || authorization.venue !== "alpaca-trading-paper" || canonical(authorization.scopes) !== canonical(["account:read", "positions:read"]) || observedAt >= validUntil) throw new TypeError("current-readonly-paper-observation-authorization-required");
    return Object.freeze({ authorization, at });
  };
  const observeEstherPaperAccount = async ({ authorizationReference, at = now() }) => {
    const { authorization } = await preflight({ authorizationReference, at });
    const [account, positions] = await Promise.all([adapter.readAccount({ observationAuthorization: authorization, now: at }), adapter.listPositions({ observationAuthorization: authorization, now: at })]);
    const receipt = Object.freeze(identify(scrub({ type: "PrincipalPaperAccountObservationReceipt", version: 1, authority: authorization.id, accountAlias, venue: "alpaca-trading-paper", observedAt: at,
      account: { receiptId: account.id, venueRequestId: account.venueRequestId, payload: account.payload }, positions: { receiptId: positions.id, venueRequestId: positions.venueRequestId, payload: positions.payload }, orderEffect: false, secretBytesReturned: false })));
    const bookReceipt = await recordObservation({ type: "principal-paper-account-observed", value: receipt, recordedAt: at });
    if (!bookReceipt?.id && !bookReceipt?.graph && !bookReceipt?.recordReceipt) throw new TypeError("paper-observation-independent-book-receipt-required");
    return Object.freeze({ ...receipt, independentBooksReceipt: scrub(bookReceipt) });
  };
  return Object.freeze({ originatingActor: "urn:ame:alpaca-paper-account-read-service", preflight, observeEstherPaperAccount, credentialReference: credential });
}
