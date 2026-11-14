# Verified platform facts used by the social adapters

Read from the official documentation on 2026-11-14. The adapters in `src/venture-engine/social-adapters.ts`
use only these facts. Re-check them when the platforms change their APIs.

## Instagram (Instagram API with Instagram Login)

Sources: developers.facebook.com/documentation/instagram-platform/ — content-publishing, instagram-api-with-instagram-login,
instagram-api-with-instagram-login/get-started, app-review, instagram-graph-api/reference/ig-user/media,
…/ig-user/media_publish, …/ig-user/content_publishing_limit, …/ig-container, reference/refresh_access_token,
reference/instagram-media (IG Media), instagram-graph-api/reference/error-codes.

- Professional accounts (Business or Creator). With Instagram Login, "This API setup does not require a Facebook Page
  to be linked to the Instagram professional account."
- Host `graph.instagram.com`; latest API version stated: `v27.0`. Permissions: `instagram_business_basic`,
  `instagram_business_content_publish`.
- App Review: "My app is only for a business I own or manage — No login or Instagram Login — Standard Access — Not
  required." The Meta app must be a Business type app.
- Token: from the App Dashboard (Instagram > API setup with Instagram business login > Generate token): "long-lived
  and are valid for 60 days". Refresh: `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=…`
  for a long-lived token "at least 24 hours old but has not expired"; refreshed tokens are valid for 60 days.
- Account id: `GET /v27.0/me?fields=user_id,username` (`user_id` is the professional account id).
- Publish: `POST /<IG_ID>/media` with `image_url` (+ `caption`, `alt_text`) → container `id`;
  `GET /<IG_CONTAINER_ID>?fields=status_code` → `EXPIRED | ERROR | FINISHED | IN_PROGRESS | PUBLISHED` ("querying a
  container's status once per minute, for no more than 5 minutes"); `POST /<IG_ID>/media_publish` with `creation_id` →
  media `id`; `GET /<IG_MEDIA_ID>?fields=permalink` → "Permanent URL to the media".
- Images: "JPEG is the only image format supported"; 8 MB maximum; aspect ratio within 4:5 to 1.91:1; width 320–1440.
  "We cURL media … so the media must be hosted on a publicly accessible server at the time of the attempt."
- Caption: maximum 2200 characters, 30 hashtags, 20 @ tags. `alt_text`: up to 1000 characters.
- Limits: the guide says 100 API-published posts per 24-hour moving period; the media_publish reference says 50.
  Check usage with `GET /<IG_ID>/content_publishing_limit` (`quota_usage`, `config.quota_total`). Automaton publishes at
  most 1 per day and checks the quota first.
- Errors (subcodes): 2207001 server error (try again), 2207003 media download timeout (try again), 2207008 temporary
  (try again 1–2 times), 2207027 media not ready, 2207042 daily publishing limit reached, 2207004 image too large,
  2207005 format not supported, 2207052 media could not be fetched, 2207050 account restricted, 2207051 suspected spam.
  Error objects carry `is_transient`.

## Pinterest (API v5)

Sources: developers.pinterest.com — docs/getting-started/connect-app, set-up-authentication-and-authorization,
key-concepts/access-tiers, reference/rate-limits, developer-tools/sandbox, api/v5/pins-create(.md),
work-with-organic-content-and-users/create-boards-and-pins.md; and Pinterest's official OpenAPI description
(github.com/pinterest/api-description, v5/openapi.json, version 5.28.0).

- A Pinterest business account administers the app; apps are reviewed for Trial access, then can upgrade to Standard.
- Trial access: creating Pins "Yes (visible only to creator)"; "all Pins and Boards created with Trial access are only
  visible to their creator as Sandbox entities". Standard access needs "a video recording of your app completing an
  action using the Pinterest API … If you are the only intended user of the Pinterest API, we will still require a
  video recording of the OAuth flow."
- Hosts: `https://api.pinterest.com/v5`; Sandbox `https://api-sandbox.pinterest.com/v5` (needs a Sandbox token).
- Create Pin: `POST /v5/pins`; scopes `boards:read, boards:write, pins:read, pins:write`; rate-limit category `org_write`.
  Body: `board_id`, `title` (max 100), `description` (max 800), `link` (max 2048), `alt_text` (max 500),
  `media_source` = `{ source_type: "image_base64", content_type: "image/jpeg" | "image/png", data }` or
  `{ source_type: "image_url", url }`. Response 201: the Pin, with `id` (no public URL field).
- Board check: `GET /v5/boards/{board_id}` (`boards:read`). Account check: `GET /v5/user_account` (`user_accounts:read`).
- Errors: JSON `{ code, message }`; 429 "The user has sent too many requests in a given amount of time and is being
  rate limited"; 401 with code 2 for an expired or invalid token.
- Tokens: access token (`pina…`) `expires_in` 2592000 (30 days); continuous refresh token (`pinr…`, 60 days,
  refreshable indefinitely). Refresh: `POST /v5/oauth/token` with HTTP Basic `client_id:client_secret`,
  `grant_type=refresh_token`, `refresh_token=…`.
- Rate limits: Trial 1000 requests/day; `org_write` Trial 300/day per app.
- The public web address of a Pin is not documented in these sources; Automaton stores the Pin id and asks the owner to
  record the Pin's link.
