# Frontend API changes: latest six `dev` commits

Generated on August 5, 2026 from `origin/dev` at `1d638779ae29a00170e621c86c69269c688e9118`.

## Scope

This document covers the frontend-visible contract and behavior changes in these six commits, oldest to newest:

| Commit    | Subject                                                 | Frontend API impact                                                                                                        |
| --------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `2912055` | `refactor: organize shared DTO and exception files`     | None; imports and file locations only                                                                                      |
| `82b1f77` | `test: remove obsolete entity specs`                    | None                                                                                                                       |
| `a89c21c` | `chore(deps): add storage and payment dependencies`     | None by itself                                                                                                             |
| `964dcb6` | `feat(properties): add randomized domain identifiers`   | Property PIN format changed; reusable randomized identifier generation added                                               |
| `8456cf2` | `feat(storage): migrate file handling to Cloudflare R2` | Breaking request-field changes and expiring private URLs                                                                   |
| `1d63877` | `feat(payments): add resilient Paystack processing`     | Required payment idempotency key, asynchronous payment completion, randomized case IDs, and expanded transaction responses |

All paths below include the existing global prefix `/api/v1`. Authentication and role requirements are unchanged unless explicitly stated.

## Required frontend changes

1. Keep the `fileId` returned by the upload API and send that ID in subsequent create/update requests. Do not send an uploaded file URL as a reference.
2. Rename all affected file request fields listed in the migration table below. Old names are rejected as non-whitelisted properties.
3. Treat private document URLs as temporary. Re-fetch the resource that owns the document when a URL expires.
4. Add a non-empty, client-generated `idempotencyKey` to every verification payment initialization request.
5. Reuse the same payment key only when retrying the same payment initialization attempt. Generate a new key for a new attempt or changed package selection.
6. Do not mark a payment successful from a Paystack redirect alone. Refresh or poll the existing order/transaction endpoints until the backend reports the final status.
7. Treat property PINs and verification case IDs as opaque strings; do not parse location or sequence information from them.

## 1. File upload and file-reference changes

### Upload endpoint

The endpoint and multipart request are unchanged:

```http
POST /api/v1/file/upload
Content-Type: multipart/form-data

file: <binary>
fileInfo: <FileType>
```

The success response now includes `expiresAt`:

```json
{
  "success": true,
  "message": "SUCCESS!",
  "data": {
    "fileId": "04e86bc7-0549-419f-9a67-40ab6be8b358",
    "url": "https://...",
    "expiresAt": "2026-08-05T12:30:00.000Z"
  },
  "status": 201
}
```

`expiresAt` is an ISO 8601 string for private R2 files and `null` for public or legacy Cloudinary files.

Only the upload response provides the `fileId`. Resource DTOs continue to expose file URLs under their existing response field names, so retain the upload's `fileId` until the related create/update request succeeds.

### Public and private file behavior

| File type                 | Access behavior                   |
| ------------------------- | --------------------------------- |
| `PROFILE_PICTURE`         | Public URL; `expiresAt: null`     |
| `COMPANY_PROFILE_PICTURE` | Public URL; `expiresAt: null`     |
| `ARTICLE_TITLE_IMAGE`     | Public URL; `expiresAt: null`     |
| Every other `FileType`    | Private signed URL with an expiry |

Private URL lifetime is environment-configured between 1,200 and 2,400 seconds (20–40 minutes); the example configuration uses 1,800 seconds. Do not persist a private URL as the document identity or assume it will work in a later session.

Responses such as `PropertyDto.certificationOfOccupancy`, `PropertyVerificationDto.verificationFiles`, and `CompanyDto.proofOfAddress` still contain URL strings, but private R2 values are signed URLs generated when the API response is built. These response DTOs do not include a separate expiry timestamp. If a document request fails because the URL is stale, fetch the owning property, verification, or company again to obtain a fresh URL.

### Breaking request-field migration

Every new file reference below must be a valid UUID returned as `data.fileId` by `POST /api/v1/file/upload`.

| Endpoint                                             | Old request field          | New request field                | Expected upload `fileInfo` |
| ---------------------------------------------------- | -------------------------- | -------------------------------- | -------------------------- |
| `POST /api/v1/article`                               | `titleImage`               | `titleImageId`                   | `ARTICLE_TITLE_IMAGE`      |
| `PATCH /api/v1/article/:id`                          | `titleImage`               | `titleImageId`                   | `ARTICLE_TITLE_IMAGE`      |
| `POST /api/v1/company/create`                        | `proofOfAddress`           | `proofOfAddressFileId`           | `PROOF_OF_ADDRESS`         |
| `POST /api/v1/company/create`                        | `profileImage`             | `profileImageId`                 | `COMPANY_PROFILE_PICTURE`  |
| `PATCH /api/v1/company/update/:id`                   | `proofOfAddress`           | `proofOfAddressFileId`           | `PROOF_OF_ADDRESS`         |
| `PATCH /api/v1/company/update/:id`                   | `profileImage`             | `profileImageId`                 | `COMPANY_PROFILE_PICTURE`  |
| `POST /api/v1/property`                              | `certificationOfOccupancy` | `certificationOfOccupancyFileId` | `CERTIFICATE_OF_OCCUPANCY` |
| `POST /api/v1/property`                              | `contractOfSale`           | `contractOfSaleFileId`           | `CONTRACT_OF_SALE`         |
| `POST /api/v1/property`                              | `surveyPlan`               | `surveyPlanFileId`               | `SURVEY_PLAN`              |
| `POST /api/v1/property`                              | `letterOfIntent`           | `letterOfIntentFileId`           | `LETTER_OF_INTENT`         |
| `PATCH /api/v1/property/:identifier`                 | `certificationOfOccupancy` | `certificationOfOccupancyFileId` | `CERTIFICATE_OF_OCCUPANCY` |
| `PATCH /api/v1/property/:identifier`                 | `contractOfSale`           | `contractOfSaleFileId`           | `CONTRACT_OF_SALE`         |
| `PATCH /api/v1/property/:identifier`                 | `surveyPlan`               | `surveyPlanFileId`               | `SURVEY_PLAN`              |
| `PATCH /api/v1/property/:identifier`                 | `letterOfIntent`           | `letterOfIntentFileId`           | `LETTER_OF_INTENT`         |
| `PATCH /api/v1/property/:identifier`                 | `deedOfConveyance`         | `deedOfConveyanceFileId`         | `DEED_OF_CONVEYANCE`       |
| `POST /api/v1/property/:identifier/sub`              | `deedOfConveyance`         | `deedOfConveyanceFileId`         | `DEED_OF_CONVEYANCE`       |
| `POST /api/v1/property/:identifier/sub`              | `contractOfSale`           | `contractOfSaleFileId`           | `CONTRACT_OF_SALE`         |
| `POST /api/v1/property/:identifier/sub`              | `surveyPlan`               | `surveyPlanFileId`               | `SURVEY_PLAN`              |
| `POST /api/v1/verification/initiate`                 | `verificationFiles`        | `verificationFileIds`            | `VERIFICATION_DOCUMENT`    |
| `PATCH /api/v1/verification/:verificationId/update`  | `verificationFiles`        | `verificationFileIds`            | `VERIFICATION_DOCUMENT`    |
| `PATCH /api/v1/admin/verification/:id/advance-stage` | `verificationFiles`        | `verificationFileIds`            | `ADMIN_STAGE_DOCUMENT`     |
| `PATCH /api/v1/user/update`                          | `profileImageUrl`          | `profileImageId`                 | `PROFILE_PICTURE`          |

Property `otherDocuments` entries also changed:

```diff
{
  "label": "Governor's consent",
- "url": "https://..."
+ "fileId": "04e86bc7-0549-419f-9a67-40ab6be8b358"
}
```

Upload these with `fileInfo=PROPERTY_OTHER_DOCUMENT`.

For `PATCH /api/v1/property/:identifier`, `otherDocuments` has these existing semantics:

- Omit the field to leave the collection unchanged.
- Send `[]` to clear the collection.
- Send a non-empty array to replace the collection. Each entry must use `fileId`; labels and file IDs must each be unique within the array.

### Request example: create a property with uploaded documents

```json
{
  "name": "Example property",
  "polygon": {
    "type": "Polygon",
    "coordinates": [
      [
        [3.3, 6.5],
        [3.4, 6.5],
        [3.4, 6.6],
        [3.3, 6.5]
      ]
    ]
  },
  "propertyType": "LAND",
  "address": "Example address",
  "city": "Lagos",
  "state": "Lagos",
  "certificationOfOccupancyFileId": "b767dddf-a815-4386-927c-cbb0cbf4511c",
  "contractOfSaleFileId": "4a51fc70-a5f0-44c2-b711-c044929bbd48",
  "surveyPlanFileId": "13a03903-c770-4aa3-b1d9-f6d0b8cb2165",
  "otherDocuments": [
    {
      "label": "Governor's consent",
      "fileId": "04e86bc7-0549-419f-9a67-40ab6be8b358"
    }
  ],
  "isSubmitted": false
}
```

The file's uploaded `fileInfo` must match the field where it is later attached. A mismatched type returns `400 Bad Request` with `File type do not match`; an unknown ID returns `404 Not Found` with `File not found`.

### Response field names remain URL-based

The request migration does not rename the corresponding response fields. Examples:

- `ArticleDto.titleImage` remains a URL.
- `CompanyDto.proofOfAddress` and `CompanyDto.profileImage` remain URLs.
- `UserDto.profileImage` remains a URL.
- `PropertyDto.certificationOfOccupancy`, `contractOfSale`, `surveyPlan`, `letterOfIntent`, and `deedOfConveyance` remain URLs.
- `PropertyDto.otherDocuments[]` remains `{ label, url }`.
- `PropertyVerificationDto.verificationFiles` and `adminStageFiles` remain URL arrays.

## 2. Payment initialization and status changes

### Breaking request change

`idempotencyKey` is now required:

```http
POST /api/v1/payment/initialize/verification/:verificationId
Authorization: Bearer <access-token>
Content-Type: application/json
```

```json
{
  "packageId": "1d7d48f8-e4e7-4c83-aa96-8548e5ff67f5",
  "idempotencyKey": "45dcd359-dff0-459e-817f-828fef17c074"
}
```

`packageId` must be a UUID. `idempotencyKey` may be any non-empty string; a client-generated UUID is recommended because keys are globally unique across payment transactions.

Use the key as follows:

- Generate one key when the user begins a specific payment initialization attempt.
- Keep it in frontend state until initialization succeeds or the user abandons that attempt.
- If a timeout or network error leaves the result unknown, retry the same request with the same key.
- A replay by the same user returns the original Paystack checkout details and order instead of creating another transaction.
- Generate a new key when starting a genuinely new attempt or changing the selected package.
- Reusing another user's key returns `409 Conflict`.

If a transaction is already pending for the same verification and package, a new key can return `400 Bad Request` with `A payment transaction is already pending for this verification package`. In an uncertain retry, reuse the original key instead of generating another one.

### Initialization response

The successful top-level response envelope remains `ApiResponse` and the checkout fields remain snake_case:

```ts
type PaymentInitializationResponse = {
  success: true;
  message: 'SUCCESS!';
  status: 200;
  data: {
    paystackDetails: {
      authorization_url: string;
      access_code: string;
      reference: string;
    };
    order: Order;
    propertyVerification: PropertyVerification;
  };
};
```

Redirect the user to `data.paystackDetails.authorization_url`. Do not construct a Paystack URL from the access code or reference.

Amounts returned by verification-package, order, and transaction APIs remain numbers in major currency units. For example, `150000` means NGN 150,000, not 150,000 kobo. The new minor-unit storage and Paystack conversion are backend-only.

### Initialization errors relevant to UI handling

Errors use the existing `ApiResponse` error envelope: `success: false`, `message: "ERROR!"`, `description`, and `status`.

| HTTP status | Condition                                                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `400`       | Missing/empty `idempotencyKey`, invalid `packageId`, verification is at the wrong stage, verification is already paid, or a payment transaction is already pending |
| `404`       | Verification does not exist/belong to the user, or the selected package is missing/inactive                                                                        |
| `409`       | The idempotency key belongs to another user                                                                                                                        |
| `500`       | Paystack initialization failed or the backend could not complete initialization                                                                                    |

### Payment completion is asynchronous

`POST /api/v1/payment/webhook` is still a Paystack-only endpoint and requires no frontend call. It now validates the raw signed payload and Paystack source IP, stores the event, and queues payment verification. The HTTP `200` webhook acknowledgement does not mean frontend-visible payment state has already changed.

After Paystack checkout or redirect:

1. Keep the UI in a processing state.
2. Query `GET /api/v1/payment/order/verification/:verificationId` and/or `GET /api/v1/payment/my-transactions`.
3. Treat `order.status === "PAID"` or `transaction.status === "SUCCESS"` as success.
4. Treat `transaction.status === "FAILED"` as failure.
5. Continue to treat `PENDING` as unresolved. The backend also reconciles stale pending transactions periodically.

On successful asynchronous verification, the backend changes the order to `PAID`, the transaction to `SUCCESS`, and the property-verification stage to `PAYMENT_VERIFIED`. The verification `caseId` may therefore remain `null` briefly after the browser returns from Paystack.

### Expanded transaction response

Transaction objects returned by these existing endpoints now expose additional fields:

- `GET /api/v1/payment/my-transactions`
- `GET /api/v1/payment/order/verification/:verificationId` under `transactions[]`
- `GET /api/v1/admin/payment/transactions`

```ts
type Transaction = {
  // Existing fields
  id: string;
  createdAt: string;
  updatedAt: string;
  amount: number;
  paystackReference: string;
  status: 'PENDING' | 'SUCCESS' | 'FAILED';
  authorizationUrl: string | null;

  // Added fields
  currency: string; // currently "NGN"
  paymentCategory: 'PROPERTY_VERIFICATION' | 'SUBSCRIPTION';
  accessCode: string | null;
  idempotencyKey: string | null;
  providerTransactionId: string | null;
  failureReason: string | null;
};
```

Legacy transaction rows can have `null` for the newly added nullable fields. Use `status` as the state authority; the presence of `failureReason` alone does not necessarily mean the transaction is `FAILED`.

`GET /api/v1/payment/order/verification/:verificationId` now explicitly returns the most recently created order. This matters when a package change supersedes and cancels an older pending order.

## 3. Property PIN and verification case ID formats

New identifiers use a random uppercase alphanumeric suffix:

| Identifier            | Previous generated format                   | New generated format                               | Example            |
| --------------------- | ------------------------------------------- | -------------------------------------------------- | ------------------ |
| Property `pin`        | `VP-{state code}-{2-digit year}-{4 digits}` | `VP-{4-digit UTC year}-{8 uppercase alphanumeric}` | `VP-2026-8Q1MZ7KP` |
| Verification `caseId` | `VR-{4-digit year}-{3-digit sequence}`      | `VR-{4-digit UTC year}-{8 uppercase alphanumeric}` | `VR-2026-A7D2Q9WX` |

The change applies when a missing identifier is generated:

- A property PIN is generated when a property is verified.
- A verification case ID is generated when payment is successfully verified.
- Existing non-null PINs and case IDs are not rewritten by this code.

Frontend implications:

- Treat both values as opaque display and lookup strings.
- Remove validation or formatting logic that assumes the old segment count, state code, two-digit year, numeric suffix, or sequential case number.
- Do not sort by the suffix as if it were creation order.
- Property lookup by a `VP-...` identifier now normalizes the supplied PIN to uppercase, so mixed/lowercase input is accepted for lookup.

## 4. Frontend migration checklist

- [ ] Update shared request types for every renamed file field.
- [ ] Store `data.fileId` separately from the upload preview/download URL.
- [ ] Ensure each upload uses the `fileInfo` expected by its destination field.
- [ ] Replace `otherDocuments[].url` with `otherDocuments[].fileId` in property requests.
- [ ] Keep response types URL-based; do not rename response fields to `...Id`.
- [ ] Add handling for `data.expiresAt` from file uploads.
- [ ] Avoid long-lived caching of private document URLs.
- [ ] Add and correctly reuse `idempotencyKey` during payment initialization retries.
- [ ] Handle payment initialization `400`, `404`, `409`, and `500` states.
- [ ] Add a post-checkout processing state that refreshes order/transaction status.
- [ ] Accept nullable new transaction fields for legacy records.
- [ ] Remove old PIN/case-ID parsing and validation assumptions.
- [ ] Update admin verification stage requests to send `verificationFileIds`.

## 5. Unchanged contracts worth noting

- The API response envelope remains `{ success, message, data?, description?, status? }`.
- The global API prefix remains `/api/v1`.
- The upload request remains backend-proxied multipart upload; the browser does not upload directly to R2.
- `FileType` enum values did not change in this commit range.
- Payment endpoint paths did not change.
- Paystack checkout response keys remain `authorization_url`, `access_code`, and `reference`.
- Order, transaction, and verification-package amounts remain major-unit numbers at the API boundary.
