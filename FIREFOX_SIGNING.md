# Signing the Firefox XPI (Self-Distribution)

To sign your extension so it installs on standard Firefox — desktop and Android — **without changing any `about:config` settings**, you must submit it to Mozilla as an **unlisted (self-distributed) add-on** via the [Mozilla Add-on Developer Hub](https://addons.mozilla.org/developers/). Mozilla signs it automatically; the add-on stays private and is never published in the store.

References: [Signing & distribution overview](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/) · [Publishing docs](https://extensionworkshop.com/documentation/publish/)

## Step 1: Create a Developer Account

1. Go to the [Mozilla Add-on Developer Hub](https://addons.mozilla.org/developers/) and sign in with a Firefox (Mozilla) Account.
2. Complete your profile registration if it is your first time.

## Step 2: Get Your API Credentials (JWT Issuer and Secret)

To sign builds from the console instead of uploading them manually in the browser every time, you need API keys:

1. Open your [API Keys page](https://addons.mozilla.org/en-US/developers/addon/api/key/) on the Developer Hub.
2. Click **Generate new credentials**.
3. Copy your **JWT issuer** (API Key) and **JWT secret** (API Secret). Keep them private.

## Step 3: Ensure the Manifest Has an Add-on ID

Firefox requires an explicit `id` inside `browser_specific_settings` in `manifest.json` before it will sign (or permanently install) the package:

```json
{
  "manifest_version": 3,
  "name": "My Custom Extension",
  "version": "1.0",
  "browser_specific_settings": {
    "gecko": {
      "id": "my-custom-extension@yourdomain.com"
    }
  }
}
```

The Firefox build of this extension (`extension/dist/firefox/manifest.json`) already contains a `browser_specific_settings.gecko.id`.

## Step 4: Sign via Terminal (`web-ext`)

Mozilla's official `web-ext` tool packages and signs the extension directly from the console:

1. Install `web-ext` globally via Node.js:

   ```bash
   npm install --global web-ext
   ```

2. Open a terminal inside the extension project directory:

   ```bash
   cd /path/to/your/extension
   ```

3. Run the sign command with your API keys and the **unlisted** channel (so it stays private and is not listed on AMO):

   ```bash
   web-ext sign --api-key="YOUR_JWT_ISSUER" --api-secret="YOUR_JWT_SECRET" --channel="unlisted"
   ```

4. `web-ext` automatically bundles your code and submits it to Mozilla's automated review server.
5. When it finishes (usually a few seconds), look inside your project folder for a newly generated `web-ext-artifacts/` directory. It contains your officially signed `.xpi` file.

You can now send that signed `.xpi` file to desktop Firefox or Firefox for Android and install it permanently — no hidden flags required:

- **Desktop:** `about:addons` → gear icon → *Install Add-on From File…*
- **Android:** open the `.xpi` in Firefox for Android (or serve it over HTTPS and tap the download link), confirm the install prompt.
