# Nợ Ơi! API

The API stores requests for help as `pending`. Only a moderator can approve a request; only approved records appear in the public feed. It does not collect phone numbers, email addresses, identity documents, card data, passwords, or OTPs. A submitter must explicitly consent to public display of their bank name, account-holder name, and account number. Each submitter receives a one-time deletion token; only its SHA-256 digest is stored.

## Local checks

From this directory:

```powershell
npm.cmd test
```

For a local API server, run `npm.cmd install`, copy `.dev.vars.example` to `.dev.vars`, replace the sample values with private random secrets, apply `schema.sql` to the local D1 database, then run `npm.cmd run dev`. `.dev.vars` is git-ignored.

## Cloudflare deployment

1. Install the Wrangler dependency: `npm.cmd install`.
2. Sign in to Cloudflare with `npx.cmd wrangler login`.
3. Use the existing D1 database ID in `wrangler.toml`, or create one and update the config if this is a new account.
4. Apply the schema to the remote database: `npx.cmd wrangler d1 execute no-oi --remote --file=schema.sql`.
5. Set two randomly generated secrets. Keep them private and do not commit them:

   ```powershell
   npx.cmd wrangler secret put ADMIN_API_TOKEN
   npx.cmd wrangler secret put RATE_LIMIT_SECRET
   ```

6. Deploy with `npm.cmd run deploy`. The API will be available at `https://no-oi-api.<your-account>.workers.dev`.
7. Set the API URL in the frontend and admin page `api-base-url` meta tags, commit the change, and push the static site to GitHub Pages.

The production deployment for this project uses the database ID already written in `wrangler.toml`. The admin token is generated locally in the git-ignored `backend/admin-token.txt`; copy it into the password field at `https://ngockhanhyp.github.io/no-oi/admin.html`. Keep the token private. The worker URL configured in `index.html` and `admin.html` must match the deployed Worker.

The API accepts submissions at `POST /api/campaigns`; they remain pending. Save the returned deletion token privately; `DELETE /api/submissions/{id}` with that token permanently removes the submitter's record. The owner-facing dashboard is `/admin.html`; it sends the bearer token only in API requests and does not persist it in browser storage. A moderator can also review `GET /api/admin/submissions`, then call `POST /api/admin/submissions/{id}/approve` or `/reject`. `DELETE /api/admin/submissions/{id}` permanently removes any record. The public feed is `GET /api/campaigns`.

The hard-coded hourly cap is three submissions per IP. The stored rate-limit key is an HMAC of the IP using `RATE_LIMIT_SECRET`; the raw IP is not stored. Do not publish the admin token or place it in frontend code. This MVP does not verify identities, process or hold donations, or replace a human moderation and privacy process. Donations go directly from a donor to the account shown; the platform cannot confirm transfers or guarantee a recipient's identity. Do not describe a submitted campaign as verified merely because it was approved for publication. Review applicable local laws and publish clear terms and a privacy notice before inviting the public to use the service.
