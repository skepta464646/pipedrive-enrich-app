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
    .error { color: #f44336 !important; text-align: left !important; }
    #detail {
      margin-top: 8px;
      font-size: 12px;
      color: #555;
      text-align: left;
      background: #fff3f3;
      border: 1px solid #ffcdd2;
      border-radius: 6px;
      padding: 8px;
      display: none;
      white-space: pre-wrap;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <button id="btn" onclick="enrich()">🤖 Enrich with AI</button>
  <div id="status"></div>
  <div id="detail"></div>
  <script src="https://cdn.jsdelivr.net/npm/@pipedrive/app-extensions-sdk@1/dist/pipedrive-sdk.min.js"></script>
  <script>
    let sdk, orgId, orgName, orgWebsite;

    // Backend: Make.com scenario "Pipedrive Enrich Button" (team Sales, eu2).
    const BACKEND_URL = 'https://hook.eu2.make.com/gqlvtwea4ii97221qqttjmg19738sfe5';

    // Short human titles per backend error scenario.
    const SCENARIO_TITLES = {
      MISSING_ORGANIZATION_ID: 'No organization ID — open this panel from an organization page',
      MISSING_COMPANY_NAME: 'Organization has no name in Pipedrive',
      PIPEDRIVE_TOKEN_INVALID: 'Pipedrive API token invalid — update it in the Make scenario',
      PIPEDRIVE_ORG_NOT_FOUND: 'Organization not found in Pipedrive',
      PIPEDRIVE_FETCH_FAILED: 'Cannot read organization from Pipedrive',
      PIPEDRIVE_UPDATE_FAILED: 'Pipedrive refused the field update',
      AI_KEY_INVALID: 'GPT key invalid — update it in the Make scenario',
      AI_CREDITS_REQUIRED: 'Need to add credits to GPT',
      AI_CREDIT_OR_RATE_LIMIT: 'GPT key invalid or need to add credits to GPT',
      AI_BAD_REQUEST: 'GPT request rejected — check model settings',
      AI_TEMPORARY_ERROR: 'GPT temporarily down — try again',
      AI_UNKNOWN_ERROR: 'GPT error'
    };

    // Strip characters that would break JSON embedding on the backend.
    function clean(s) {
      return String(s || '').replace(/["\\\\\\n\\r\\t]/g, "'");
    }

    async function init() {
      sdk = await AppExtensionsSDK().initialize({ size: { height: 80 } });
      const data = await sdk.getContext();
      orgId = data.context.id;
      orgName = data.context.name;
      orgWebsite = data.context.website || '';
    }

    function showError(title, detailText) {
      const status = document.getElementById('status');
      const detail = document.getElementById('detail');
      status.textContent = '❌ ' + title;
      status.className = 'error';
      if (detailText) {
        detail.textContent = detailText;
        detail.style.display = 'block';
      }
      if (sdk) sdk.execute('resize', { height: 240 }).catch(() => {});
    }

    function hideError() {
      const detail = document.getElementById('detail');
      detail.style.display = 'none';
      detail.textContent = '';
    }

    async function enrich() {
      const btn = document.getElementById('btn');
      const status = document.getElementById('status');
      btn.disabled = true;
      btn.textContent = '⏳ Enriching...';
      status.textContent = 'Fetching data from web & AI...';
      status.className = '';
      hideError();
      try {
        let res;
        try {
          res = await fetch(BACKEND_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organizationId: String(orgId), name: clean(orgName), website: clean(orgWebsite) })
          });
        } catch (networkErr) {
          showError('Make.com is not reachable', 'The Make.com webhook did not answer at all. Check make.com status and that the scenario "Pipedrive Enrich Button" is turned ON. (' + networkErr.message + ')');
          btn.textContent = '🤖 Enrich with AI';
          btn.disabled = false;
          return;
        }

        let data;
        try {
          data = await res.json();
        } catch (parseErr) {
          showError('Make.com scenario crashed (HTTP ' + res.status + ')', 'The Make.com scenario answered without valid JSON — it probably stopped mid-run or is turned OFF. Open Make.com -> scenario "Pipedrive Enrich Button" -> History to see the failed run.');
          btn.textContent = '🤖 Enrich with AI';
          btn.disabled = false;
          return;
        }

        if (data.success) {
          status.textContent = '✅ ' + data.fields_filled + ' fields filled!';
          status.className = 'success';
          btn.textContent = '🔄 Enrich again';
          if (data.alert && data.alert.message) {
            const detail = document.getElementById('detail');
            detail.textContent = 'ℹ️ ' + data.alert.message;
            detail.style.display = 'block';
            if (sdk) sdk.execute('resize', { height: 200 }).catch(() => {});
          } else {
            setTimeout(() => location.reload(), 2000);
          }
        } else {
          const title = SCENARIO_TITLES[data.scenario] || (data.scenario ? data.scenario.replaceAll('_', ' ') : 'Unknown error');
          const parts = [];
          if (data.error) parts.push('Details: ' + data.error);
          if (data.solution) parts.push('How to fix: ' + data.solution);
          showError(title, parts.join('\\n\\n'));
          btn.textContent = '🤖 Enrich with AI';
        }
      } catch (err) {
        showError('Unexpected error: ' + err.message, '');
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
