# Epic E5: API Ergonomics

## ACF-501 Idempotency keys
Status: DONE

Scope:
- Require `Idempotency-Key` for mutating commands.

Acceptance criteria:
- Duplicate requests return same result without duplicate events.

## ACF-502 Structured errors
Status: DONE

Scope:
- Standard error envelope and code registry.

Acceptance criteria:
- All error responses include `code`, `message`, `details`, `requestId`.

## ACF-503 Rate-limit headers
Status: DONE

Scope:
- Add standard rate headers on responses.

Acceptance criteria:
- Headers consistent and documented.

## ACF-504 Domain validation errors
Status: DONE

Scope:
- Canonical codes such as `ERR_OUT_OF_BOUNDS`.

Acceptance criteria:
- Validation failures map to deterministic codes.
