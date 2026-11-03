# Nợ Ơi! API

The API stores anonymous requests for help as `pending`. Only a moderator can approve a request; only approved records appear in the public feed. It deliberately does not collect bank details, phone numbers, email addresses, identity documents, or payment information. Each submitter receives a one-time deletion token; only its SHA-256 digest is stored.

## Local checks

From this directory:

```powershell
npm.cmd test
```

For a local API server, run `npm.cmd install`, copy `.dev.vars.example` to `.dev.vars`, replace the sample values with private random secrets, apply `schema.sql` to the local D1 database, then run `npm.cmd run dev`. `.dev.vars` is git-ignored.

## Cloudflare deployment

1. Install the Wrangler dependency: `npm.cmd install`.
2. Sign in to Cloudflare with `npx.cmd wrangler login`.
3. Create the D1 database: `npx.cmd wrangler d1 create no-oi`.
4. Replace the placeholder `database_id` in `wrangler.toml` with the returned ID.
5. Apply the schema to the remote database: `npx.cmd wrangler d1 execute no-oi --remote --file=schema.sql`.
6. Set two randomly generated secrets. Keep them private and do not commit them:

   ```powershell
   npx.cmd wrangler secret put ADMIN_API_TOKEN
   npx.cmd wrangler secret put RATE_LIMIT_SECRET
   ```

7. Deploy with `npm.cmd run deploy`. The API will be available at `https://no-oi-api.<your-account>.workers.dev`.
8. Set the API URL in the frontend's `api-base-url` meta tag, commit the change, and push the static site to GitHub Pages.

The Cloudflare account must be signed in before database creation or deployment. The repository intentionally contains no API URL, database ID, or secret until deployment is completed.

The API accepts submissions at `POST /api/campaigns`; they remain pending. Save the returned deletion token privately; `DELETE /api/submissions/{id}` with that token permanently removes the submitter's record. A moderator reviews `GET /api/admin/submissions` with a bearer token, then calls `POST /api/admin/submissions/{id}/approve` or `/reject`. `DELETE /api/admin/submissions/{id}` permanently removes any record. The public feed is `GET /api/campaigns`.

The hard-coded hourly cap is three submissions per IP. The stored rate-limit key is an HMAC of the IP using `RATE_LIMIT_SECRET`; the raw IP is not stored. Do not publish the admin token or place it in frontend code. This MVP does not verify identities, accept donations, or replace a human moderation and privacy process. Do not describe a submitted campaign as verified merely because it was approved for publication.
