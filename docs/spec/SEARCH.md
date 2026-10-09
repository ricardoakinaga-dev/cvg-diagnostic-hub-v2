# Search

**Knowledge status:** `DECISION` técnica proposta para PostgreSQL; volumes, campos pessoais e performance final são `ASSUMPTION`/`OPEN QUESTION` até o piloto.

## 1. Goals

Global search must find a request without knowing the patient and must prevent a homonym or unauthorized result from being mistaken for the target. Search is a read model over authorized data, not a backdoor around resource authorization.

## 2. Searchable fields

| Field | Match | Display constraints |
| --- | --- | --- |
| request code | exact/prefix | safe to show if in scope |
| accession/sample code | exact/prefix | service scope |
| patient name | normalized text | species/sex/tutor abbreviation/external ID as allowed |
| tutor name | normalized text | only roles/policies that allow it |
| external ID | exact/prefix | source system label; no blind trust |
| service/item name/code | text/filter | scope-limited |
| department | exact/filter | operational |
| requester/reviewer | name/exact | privacy-limited; a reviewer is a **user** who acted on the request or a visible item (audit trail), matched by user id, name or e-mail; the audit trail is read only for the users that match the query (D-046) |
| status/priority/date/SLA | filters | cursor results |

## 3. API behavior

`GET /api/v1/search?q=&types=REQUEST,ITEM&status=&departmentCode=&from=&to=&cursor=&limit=` (`department` remains a backwards-compatible route alias)

- minimum query length for text is configurable; exact protocol/accession may bypass it;
- default `limit=25`, max `100`; cursor pagination is keyset-based and stable by relevance then `updatedAt,id`; the opaque cursor represents the last `rank,updatedAt,id` tuple;
- exact `request_code` returns request first and related items summary;
- empty search is rejected or scoped to queue endpoints, never returns thousands of rows;
- result cards include type, safe label, patient context, status, priority, department, updated time and deep link; the response exposes `meta.nextCursor`, `meta.limit` and `meta.total`;
- server authorization is applied before ranking/counting to avoid existence leaks.

## 4. Ranking

1. exact request/accession/external ID;
2. prefix request/patient/service;
3. normalized text match;
4. active/actionable items before historical items;
5. priority/SLA only as display context, not as relevance surprise.

The user can see why a row appears first. Search must not use an opaque ML ranking in MVP.

## 5. Storage/index strategy

PostgreSQL indexes first: normalized exact/prefix columns, request code, external reference, item status/department/due_at and joins. `pg_trgm` is optional after representative benchmark; Elasticsearch/OpenSearch is explicitly out of scope unless query volume proves PostgreSQL inadequate.

## 6. Safety and tests

- search requests are rate-limited and length-limited;
- input is parameterized/validated; wildcard abuse is bounded;
- search result actions re-authorize on open;
- tests cover homonyms, accents, partial protocol, no patient term, unauthorized scope, empty/large result sets, pagination stability and SQL injection payloads.
