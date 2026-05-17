export default function handler(req, res) {
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, sans-serif; padding: 16px; background: #fff; }
    button {
      width: 100%;
      padding: 12px;
      background: #2196F3;
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      cursor: pointer;
      font-weight: 600;
    }
    button:hover { background: #1976D2; }
    button:disabled { background: #ccc; cursor: not-allowed; }
    #status { margin-top: 12px; font-size: 13px; color: #666; text-align: center; }
    .success { color: #4CAF50 !important; }
    .error { color: #f44336 !important; }
  </style>
</head>
<body>
  <button id="btn" onclick="enrich()">🤖 Enrich with AI</button>
  <div id="status"></div>
  <script src="https://cdn.jsdelivr.net/npm/@pipedrive/app-extensions-sdk@1/dist/pipedrive-sdk.min.js"></script>
  <script>
    let sdk, orgId, orgName, orgWebsite;
    async function init() {
      sdk = await AppExtensionsSDK().initialize({ size: { height: 80 } });
      const data = await sdk.getContext();
      orgId = data.context.id;
      orgName = data.context.name;
      orgWebsite = data.context.website || '';
    }
    async function enrich() {
      const btn = document.getElementById('btn');
      const status = document.getElementById('status');
      btn.disabled = true;
      btn.textContent = '⏳ Enriching...';
      status.textContent = 'Fetching data from web & AI...';
      status.className = '';
      try {
        const res = await fetch('https://pipedrive-enrich-app.vercel.app/api/enrich', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ organizationId: String(orgId), name: orgName, website: orgWebsite })
        });
        const data = await res.json();
        if (data.success) {
          status.textContent = '✅ ' + data.fields_filled + ' fields filled!';
          status.className = 'success';
          btn.textContent = '🔄 Enrich again';
          setTimeout(() => location.reload(), 2000);
        } else {
          throw new Error(data.error || 'Unknown error');
        }
      } catch (err) {
        status.textContent = '❌ Error: ' + err.message;
        status.className = 'error';
        btn.textContent = '🤖 Enrich with AI';
      }
      btn.disabled = false;
    }
    init();
  </script>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html');
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', 'frame-ancestors *');
  res.status(200).send(html);
}
