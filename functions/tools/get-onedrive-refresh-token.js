const fetch = require("node-fetch");

const clientId = process.env.ONEDRIVE_CLIENT_ID;
const clientSecret = process.env.ONEDRIVE_CLIENT_SECRET || "";
const scope = "Files.Read offline_access";
const tenant = "consumers";

if (!clientId) {
  console.error("Missing ONEDRIVE_CLIENT_ID env var.");
  process.exit(1);
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const deviceUrl = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/devicecode`;
  const tokenUrl = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;

  const deviceResp = await fetch(deviceUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      scope
    })
  });

  if (!deviceResp.ok) {
    const err = await deviceResp.text();
    throw new Error(`Device code error: ${err}`);
  }

  const device = await deviceResp.json();
  console.log("\nOpen:", device.verification_uri);
  console.log("Code:", device.user_code);
  console.log("\nWaiting for login...");

  const expiresAt = Date.now() + (device.expires_in * 1000);
  const interval = (device.interval || 5) * 1000;

  while (Date.now() < expiresAt) {
    await sleep(interval);

    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: clientId,
      device_code: device.device_code
    });

    if (clientSecret) {
      body.append("client_secret", clientSecret);
    }

    const tokenResp = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });

    const data = await tokenResp.json();

    if (data.error) {
      if (data.error === "authorization_pending") {
        continue;
      }
      if (data.error === "slow_down") {
        continue;
      }
      throw new Error(`Token error: ${JSON.stringify(data)}`);
    }

    if (data.refresh_token) {
      console.log("\nREFRESH_TOKEN:");
      console.log(data.refresh_token);
      return;
    }

    throw new Error(`Unexpected token response: ${JSON.stringify(data)}`);
  }

  throw new Error("Device code expired before authorization completed.");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
