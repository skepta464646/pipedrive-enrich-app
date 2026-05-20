export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      scenario: 'REQUEST_METHOD_ERROR',
      error: 'Method not allowed. This endpoint accepts POST only.',
      solution: 'Call this endpoint with POST from Pipedrive/Vercel.'
    });
  }

  const startedAt = Date.now();
  const { organizationId } = req.body || {};
  const debugMode = req.body?.debug === true;
  let { name, website } = req.body || {};

  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  const PD_TOKEN = process.env.PIPEDRIVE_API_TOKEN;
  const PD_DOMAIN = process.env.PIPEDRIVE_DOMAIN;
  const TAVILY_KEY = process.env.TAVILY_API_KEY;

  const FIELD = {
    website: '783923cad610ca666dc3ddac86085a6468c7b809',
    icp: '0d5afcefbd6ada8781d38fe74873d4b308234a49',
    ownership: '5b6f71999f89a4ac00ed32f8bd49bc8480bf459d',
    icp_type: 'ef79b1ce2c6860be02443dd9728ad62dd4f8b18c',
    qualify_status: '18ba6331d70bcfa1eb8cf977c52948c4f2b53df3',
    employees_category: '113a8ed69dfd080a7d1b84392251a3474d989216',
    org_source: '95d37d3df1ed511ae90f7fac64eac37a20f4ed83',
    icp_ecosystem: 'e37b931ae0af55393fc51f1b2135c2355b4bea12',
    his_identification: 'bb5ec6a8351b0d3423011da1f8dbfd89d8590b27',
    linkedin: '0139565cc0f6a8dcc0cae8244b672600adf64860',
    phone: '99c1cffae1ed208819f80c4c3a1b545d461082bb',
    email: 'b83bf5f8378a2275b475db4dc64b1101ea48836a',
    company_legal_name: 'b4c2b2ef4b92a130ec7de91f4d17622d5640431e',
    his_software_name: '115cfff712c6caf184d7c155838a9dace81e8821',
    ceo_name: '4107458f7b06285686f1968fbefa9ea50902cf07',
    address: '6d64ec2abf8d9a01a64c0cbf2f962281845b1c85',
    vat: 'aa9502b251dece8bf94fd779579676f711c7c17d',
    registration_number: '0d6adf6f65d52b61826d207cc40357265b6d6402',
    // Add this env var only if Pipedrive has a separate custom field for KRS number.
    krs_number: process.env.PD_FIELD_KRS_NUMBER || '',
    number_of_beds: '03ed00fa62b2687bb7ec4a2b6c3194cc828d81db',
    number_of_branches: 'bdc6f4f7031fa45a45aa4cd4cd3014f66f9847cf',
    number_of_specialists: '598c7ea3d04ce28a52985dc15a7f74cb6ff977f3'
  };

  const warnings = [];

  function warn(code, message, extra = {}) {
    console.warn(`[${code}] ${message}`, extra);
    warnings.push({ code, message, ...extra });
  }

  function fail(status, scenario, error, solution, extra = {}) {
    return res.status(status).json({
      success: false,
      scenario,
      error,
      solution,
      runtime_ms: Date.now() - startedAt,
      warnings,
      ...extra
    });
  }

  function safeString(value) {
    if (value === null || value === undefined) return '';
    return String(value).trim();
  }

  function isEmpty(value) {
    if (value === null || value === undefined) return true;
    if (typeof value === 'string') {
      const cleaned = value.trim();
      return cleaned === '' || cleaned === '-';
    }
    return false;
  }

  function isEmptyAI(value) {
    if (value === null || value === undefined || value === 0) return true;
    if (typeof value === 'string') {
      const cleaned = value.trim();
      return cleaned === '' || cleaned === '-';
    }
    return false;
  }

  function normalizeWebsiteDomain(url) {
    const raw = safeString(url);
    if (!raw) return '';
    return raw
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .split('/')[0]
      .trim()
      .toLowerCase();
  }

  function stripDiacritics(value) {
    return safeString(value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  function employeesToCategory(count) {
    const n = Number(count);
    if (!n || n <= 0) return 0;
    if (n <= 10) return 49;
    if (n <= 50) return 50;
    if (n <= 200) return 51;
    if (n <= 500) return 52;
    if (n <= 1000) return 53;
    if (n <= 5000) return 54;
    if (n <= 10000) return 55;
    return 56;
  }

  function getCountryRegistry(websiteUrl, companyName) {
    const domain = safeString(websiteUrl).toLowerCase();
    const rawName = safeString(companyName).toLowerCase();
    const nameLower = stripDiacritics(rawName).toLowerCase();

    if (
      domain.includes('.pl') ||
      nameLower.includes(' sp. z o.o') ||
      nameLower.includes(' sp z oo') ||
      nameLower.includes(' s.a.') ||
      nameLower.includes(' sp.k') ||
      nameLower.includes('spolka') ||
      nameLower.includes('spolka z ograniczona')
    ) {
      return {
        country: 'pl',
        label: 'Poland',
        registries: [
          'biznes.gov.pl',
          'wyszukiwarka-krs.ms.gov.pl',
          'ekrs.ms.gov.pl',
          'ems.ms.gov.pl',
          'rejestr.io',
          'imsig.pl'
        ]
      };
    }

    if (domain.includes('.lt') || nameLower.includes(', uab') || nameLower.includes(', ab') || nameLower.includes(', mb')) {
      return { country: 'lt', label: 'Lithuania', registries: ['rekvizitai.lt'] };
    }
    if (domain.includes('.se') || nameLower.includes(' ab ') || nameLower.endsWith(' ab')) {
      return { country: 'se', label: 'Sweden', registries: ['allabolag.se'] };
    }
    if (domain.includes('.de') || nameLower.includes(' gmbh') || nameLower.includes(' ag ')) {
      return { country: 'de', label: 'Germany', registries: ['northdata.com'] };
    }
    if (domain.includes('.gr')) return { country: 'gr', label: 'Greece', registries: ['businessregistry.gr'] };
    if (domain.includes('.pt') || nameLower.includes(' lda') || nameLower.includes(', lda')) {
      return { country: 'pt', label: 'Portugal', registries: ['racius.pt'] };
    }
    if (domain.includes('.fi') || nameLower.includes(' oy ') || nameLower.endsWith(' oy') || nameLower.includes(' oyj')) {
      return { country: 'fi', label: 'Finland', registries: ['finder.fi'] };
    }
    if (domain.includes('.no') || nameLower.includes(' as ') || nameLower.endsWith(' as') || nameLower.includes(' asa')) {
      return { country: 'no', label: 'Norway', registries: ['proff.no'] };
    }
    if (domain.includes('.dk') || nameLower.includes(' a/s') || nameLower.includes(' aps')) {
      return { country: 'dk', label: 'Denmark', registries: ['cvr.dk'] };
    }
    if (domain.includes('.nl') || nameLower.includes(' b.v.') || nameLower.includes(' n.v.')) {
      return { country: 'nl', label: 'Netherlands', registries: ['kvk.nl'] };
    }
    if (domain.includes('.cz') || nameLower.includes(' s.r.o') || nameLower.includes(' a.s.')) {
      return { country: 'cz', label: 'Czechia', registries: ['rejstrik.penize.cz'] };
    }
    if (domain.includes('.hu') || nameLower.includes(' kft') || nameLower.includes(' zrt')) {
      return { country: 'hu', label: 'Hungary', registries: ['e-cegjegyzek.hu'] };
    }
    if (domain.includes('.ro') || nameLower.includes(' srl ') || nameLower.endsWith(' srl')) {
      return { country: 'ro', label: 'Romania', registries: ['listafirme.ro'] };
    }
    if (domain.includes('.bg')) return { country: 'bg', label: 'Bulgaria', registries: ['papagal.bg'] };
    if (domain.includes('.hr') || nameLower.includes(' d.o.o') || nameLower.includes(' d.d.')) {
      return { country: 'hr', label: 'Croatia', registries: ['fininfo.hr'] };
    }
    if (domain.includes('.ee') || nameLower.includes(' ou') || rawName.includes(' oü')) {
      return { country: 'ee', label: 'Estonia', registries: ['teatmik.ee'] };
    }
    if (domain.includes('.lv') || nameLower.includes(' sia ') || nameLower.endsWith(' sia')) {
      return { country: 'lv', label: 'Latvia', registries: ['lursoft.lv'] };
    }
    if (domain.includes('.com.tr') || domain.includes('.tr')) {
      return { country: 'tr', label: 'Turkey', registries: ['sirketbilgileri.com'] };
    }

    return null;
  }

  function isPrivateLegalForm(companyName) {
    const n = stripDiacritics(companyName).toLowerCase();
    const privateForms = [
      ', uab', ', mb', ' sp. z o.o', ' sp z oo', ' s.r.o', ' gmbh', ' b.v.', ', lda',
      ' kft', ' oü', ' ou', ' sia', ' srl', ' d.o.o', ' aps', ' bv', ' sas', ' sarl',
      'spolka z ograniczona'
    ];
    return privateForms.some((form) => n.includes(form));
  }

  function extractPolishIds(text) {
    const compact = safeString(text).replace(/[\u00A0\t\r\n]+/g, ' ').replace(/\s+/g, ' ');
    const noSpacesAroundDigits = compact.replace(/(?<=\d)[\s-]+(?=\d)/g, '');
    const result = { krs: '', nip: '', regon: '' };

    const krsMatch =
      noSpacesAroundDigits.match(/\bKRS\s*[:#-]?\s*(\d{10})\b/i) ||
      noSpacesAroundDigits.match(/\bNumer\s+KRS\s*[:#-]?\s*(\d{10})\b/i) ||
      noSpacesAroundDigits.match(/\bNr\s+KRS\s*[:#-]?\s*(\d{10})\b/i);

    const nipMatch =
      noSpacesAroundDigits.match(/\bNIP\s*[:#-]?\s*(\d{10})\b/i) ||
      noSpacesAroundDigits.match(/\bNumer\s+NIP\s*[:#-]?\s*(\d{10})\b/i) ||
      noSpacesAroundDigits.match(/\bVAT\s*[:#-]?\s*(?:PL)?\s*(\d{10})\b/i) ||
      noSpacesAroundDigits.match(/\bPL\s*(\d{10})\b/i);

    const regonMatch =
      noSpacesAroundDigits.match(/\bREGON\s*[:#-]?\s*(\d{9}|\d{14})\b/i) ||
      noSpacesAroundDigits.match(/\bNumer\s+REGON\s*[:#-]?\s*(\d{9}|\d{14})\b/i);

    if (krsMatch?.[1]) result.krs = krsMatch[1];
    if (nipMatch?.[1]) result.nip = nipMatch[1];
    if (regonMatch?.[1]) result.regon = regonMatch[1];

    return result;
  }

  function extractGenericIds(text, country) {
    if (country === 'pl') return extractPolishIds(text);
    return { krs: '', nip: '', regon: '' };
  }

  async function tavilySearch(query, maxResults = 3, includeAnswer = false) {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: TAVILY_KEY,
        query,
        search_depth: 'basic',
        max_results: maxResults,
        include_answer: includeAnswer
      })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const err = new Error(data?.error || data?.message || `Tavily HTTP ${response.status}`);
      err.status = response.status;
      throw err;
    }

    return data;
  }

  async function tavilyExtract(urls) {
    const response = await fetch('https://api.tavily.com/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: TAVILY_KEY, urls })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const err = new Error(data?.error || data?.message || `Tavily extract HTTP ${response.status}`);
      err.status = response.status;
      throw err;
    }

    return data;
  }

  async function getPipedriveOrgFields() {
    const response = await fetch(`https://${PD_DOMAIN}.pipedrive.com/api/v1/organizationFields?api_token=${PD_TOKEN}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success) return [];
    return data.data || [];
  }

  function buildBase(extra = {}) {
    return {
      organization_id: organizationId || null,
      company_name: name || null,
      website: website || null,
      warnings,
      runtime_ms: Date.now() - startedAt,
      ...extra
    };
  }

  if (!organizationId) {
    return fail(400, 'MISSING_ORGANIZATION_ID', 'Missing organizationId.', 'Send organizationId in request body from Pipedrive automation.');
  }

  const missingEnv = [];
  if (!OPENAI_KEY) missingEnv.push('OPENAI_API_KEY');
  if (!PD_TOKEN) missingEnv.push('PIPEDRIVE_API_TOKEN');
  if (!PD_DOMAIN) missingEnv.push('PIPEDRIVE_DOMAIN');
  if (!TAVILY_KEY) missingEnv.push('TAVILY_API_KEY');

  if (missingEnv.length > 0) {
    return fail(
      200,
      'MISSING_ENV_VARS',
      `Missing required env vars: ${missingEnv.join(', ')}.`,
      'Open Vercel project settings -> Environment Variables, add missing keys, then redeploy.',
      { missing_env_vars: missingEnv }
    );
  }

  let existing = {};

  try {
    const response = await fetch(`https://${PD_DOMAIN}.pipedrive.com/api/v1/organizations/${organizationId}?api_token=${PD_TOKEN}`);
    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data.success) {
      return fail(
        200,
        'PIPEDRIVE_FETCH_FAILED',
        `Could not fetch organization from Pipedrive. HTTP ${response.status}.`,
        'Check PIPEDRIVE_DOMAIN, PIPEDRIVE_API_TOKEN, organizationId, and token permissions.',
        buildBase({ pipedrive_response: debugMode ? data : undefined })
      );
    }

    existing = data.data || {};
    if (!name) name = existing.name || '';
    if (!website) website = existing.website || existing[FIELD.website] || '';
  } catch (error) {
    return fail(
      200,
      'PIPEDRIVE_OR_VERCEL_NETWORK_ERROR',
      `Pipedrive fetch failed: ${error.message}`,
      'Most likely: wrong PIPEDRIVE_DOMAIN, Pipedrive downtime, Vercel network issue, or invalid org ID.',
      buildBase()
    );
  }

  if (!name) {
    return fail(200, 'MISSING_COMPANY_NAME', 'Company name is missing.', 'Add organization name in Pipedrive or send name in request body.', buildBase());
  }

  let searchContext = '';
  let registryContext = '';
  let foundLinkedinUrl = '';
  let registryUrls = [];
  let deterministicIds = { krs: '', nip: '', regon: '' };
  const countryInfo = getCountryRegistry(website, name);
  const websiteDomain = normalizeWebsiteDomain(website);

  try {
    const generalPromise = tavilySearch(`${name} ${website || ''} company healthcare contact phone email address`, 3, true)
      .catch((error) => ({ error }));

    const linkedinPromise = tavilySearch(`"${name}" site:linkedin.com/company`, 3, false)
      .catch((error) => ({ error }));

    const registryPromises = [];

    if (countryInfo) {
      for (const registryDomain of countryInfo.registries) {
        registryPromises.push(
          tavilySearch(`"${name}" site:${registryDomain}`, 3, false)
            .then((data) => ({ registryDomain, queryType: 'name', data }))
            .catch((error) => ({ registryDomain, queryType: 'name', error }))
        );

        if (websiteDomain) {
          registryPromises.push(
            tavilySearch(`${websiteDomain} site:${registryDomain}`, 3, false)
              .then((data) => ({ registryDomain, queryType: 'domain', data }))
              .catch((error) => ({ registryDomain, queryType: 'domain', error }))
          );
        }
      }

      if (countryInfo.country === 'pl') {
        registryPromises.push(
          tavilySearch(`"${name}" KRS NIP REGON`, 5, false)
            .then((data) => ({ registryDomain: 'general-polish-id-search', queryType: 'ids', data }))
            .catch((error) => ({ registryDomain: 'general-polish-id-search', queryType: 'ids', error }))
        );
      }
    }

    const [generalData, linkedinData, ...registryResults] = await Promise.all([
      generalPromise,
      linkedinPromise,
      ...registryPromises
    ]);

    if (generalData.error) {
      warn('TAVILY_GENERAL_FAILED', 'General Tavily search failed.', { message: generalData.error.message });
    } else {
      if (generalData.answer) searchContext += `Summary: ${generalData.answer}\n\n`;
      if (generalData.results?.length > 0) {
        searchContext += 'Web results:\n';
        for (const result of generalData.results) {
          searchContext += `- ${result.title}: ${safeString(result.content).substring(0, 300)}\nURL: ${result.url}\n`;
        }
      }
    }

    const registryCandidates = [];

    for (const entry of registryResults) {
      if (entry?.error) {
        warn('TAVILY_REGISTRY_QUERY_FAILED', `Registry query failed for ${entry.registryDomain}.`, {
          query_type: entry.queryType,
          message: entry.error.message
        });
        continue;
      }

      for (const result of entry?.data?.results || []) {
        const url = safeString(result.url);
        if (!url) continue;

        let score = 0;
        if (entry.queryType === 'domain') score += 20;
        if (entry.queryType === 'name') score += 10;
        if (entry.registryDomain === 'biznes.gov.pl') score += 30;
        if (entry.registryDomain?.includes('krs') || entry.registryDomain?.includes('ms.gov.pl')) score += 25;
        if (url.includes('gov.pl')) score += 25;
        if (entry.registryDomain === 'rejestr.io' || entry.registryDomain === 'imsig.pl') score += 15;
        if (/krs|nip|regon/i.test(result.title || '')) score += 10;
        if (/krs|nip|regon/i.test(result.content || '')) score += 10;

        registryCandidates.push({ ...result, registryDomain: entry.registryDomain, queryType: entry.queryType, score });
      }
    }

    registryCandidates.sort((a, b) => b.score - a.score);

    const uniqueRegistryCandidates = [];
    const seenUrls = new Set();

    for (const candidate of registryCandidates) {
      if (!candidate.url || seenUrls.has(candidate.url)) continue;
      seenUrls.add(candidate.url);
      uniqueRegistryCandidates.push(candidate);
      if (uniqueRegistryCandidates.length >= 5) break;
    }

    if (uniqueRegistryCandidates.length > 0) {
      registryContext += `\nRegistry data candidates (${countryInfo?.label || 'unknown country'}):\n`;

      for (const [index, result] of uniqueRegistryCandidates.entries()) {
        registryContext += `${index + 1}. [${result.registryDomain}] ${result.title}\n${safeString(result.content).substring(0, 500)}\nURL: ${result.url}\n`;
      }

      registryUrls = uniqueRegistryCandidates.map((candidate) => candidate.url).filter(Boolean);

      try {
        const extractData = await tavilyExtract(registryUrls.slice(0, 3));

        for (const [index, item] of (extractData.results || []).entries()) {
          const rawContent = item.raw_content || item.content || '';
          if (!rawContent) continue;

          registryContext += `\nFull registry extract ${index + 1}:\nURL: ${item.url || registryUrls[index]}\n${rawContent.substring(0, 6000)}\n`;

          const ids = extractGenericIds(rawContent, countryInfo?.country);
          if (!deterministicIds.krs && ids.krs) deterministicIds.krs = ids.krs;
          if (!deterministicIds.nip && ids.nip) deterministicIds.nip = ids.nip;
          if (!deterministicIds.regon && ids.regon) deterministicIds.regon = ids.regon;
        }
      } catch (error) {
        warn('TAVILY_REGISTRY_EXTRACT_FAILED', 'Tavily registry extract failed.', { message: error.message });
      }

      const idsFromSnippets = extractGenericIds(registryContext, countryInfo?.country);
      if (!deterministicIds.krs && idsFromSnippets.krs) deterministicIds.krs = idsFromSnippets.krs;
      if (!deterministicIds.nip && idsFromSnippets.nip) deterministicIds.nip = idsFromSnippets.nip;
      if (!deterministicIds.regon && idsFromSnippets.regon) deterministicIds.regon = idsFromSnippets.regon;

      searchContext += `\n${registryContext}`;
    } else if (countryInfo) {
      warn('REGISTRY_NOT_FOUND', 'No registry result found.', {
        country: countryInfo.country,
        registries: countryInfo.registries,
        name,
        websiteDomain
      });
    }

    if (linkedinData.error) {
      warn('TAVILY_LINKEDIN_FAILED', 'LinkedIn search failed.', { message: linkedinData.error.message });
    } else {
      const liResult = linkedinData.results?.find((result) => result.url?.includes('linkedin.com/company/'));
      if (liResult) {
        foundLinkedinUrl = liResult.url;
        searchContext += `\nLinkedIn: ${liResult.url}\n`;
      }
    }
  } catch (error) {
    const isCreditOrLimit = error.status === 401 || error.status === 403 || error.status === 429;
    return fail(
      200,
      isCreditOrLimit ? 'TAVILY_CREDIT_OR_AUTH_PROBLEM' : 'TAVILY_OR_VERCEL_RUNTIME_ERROR',
      `Tavily/search step failed: ${error.message}`,
      isCreditOrLimit
        ? 'Check TAVILY_API_KEY and Tavily credits/limits. If credits are finished, add credits or update the key in Vercel env vars.'
        : 'Most likely: Tavily temporary issue, Vercel timeout/network issue, or malformed response. Check Vercel runtime logs.',
      buildBase({ tavily_status: error.status || null })
    );
  }

  const fullSearchContextLength = searchContext.length;
  searchContext = searchContext.slice(0, 9000);

  let enriched = {};

  const errorBase = buildBase({
    fields_filled: 0,
    tavily_used: !!searchContext,
    registry_used: !!registryContext,
    registry_urls: registryUrls,
    linkedin_found: !!foundLinkedinUrl,
    deterministic_ids: deterministicIds,
    ...(debugMode && {
      debug: {
        country_info: countryInfo,
        full_search_context_length: fullSearchContextLength,
        registry_context: registryContext.substring(0, 3000),
        search_context: searchContext.substring(0, 2000)
      }
    })
  });

  try {
    const polishRules = countryInfo?.country === 'pl'
      ? `\nPOLAND RULES:\n- KRS = krs_number. Exactly 10 digits.
- NIP = vat. Exactly 10 digits; may appear as NIP or PL + 10 digits.
- REGON = registration_number. 9 or 14 digits.
- Do NOT use KRS as registration_number. Do NOT use REGON as KRS.
- Look for: KRS, Numer KRS, NIP, Numer NIP, REGON, Siedziba, Adres, Zarząd, Prezes Zarządu.
`
      : '';

    const prompt = `You are a B2B healthcare CRM specialist. Return ONLY valid JSON, no markdown, no explanation.

Enrich this company:
Name: ${name}
Website: ${website || 'unknown'}
Address: ${existing.address?.value || 'unknown'}
Country detected: ${countryInfo?.label || 'unknown'}

Deterministic IDs already extracted by regex:
KRS: ${deterministicIds.krs || ''}
NIP/VAT: ${deterministicIds.nip || ''}
REGON: ${deterministicIds.regon || ''}
${polishRules}
${searchContext ? `\nContext, including official registry data if available:\n${searchContext}` : ''}

IMPORTANT:
- License Agreement fields: fill ONLY from official registry or website sources in context. Leave "" if not found.
- ceo_name: extract from registry if available.
- vat: extract TAX ID / NIP / VAT number from registry. For Poland use NIP.
- registration_number: for Poland extract REGON, not KRS. For other countries use the local registration/company number.
- address: extract legal/registered address from registry.
- qualify_status: use 724 when both email and phone found, 725 phone only, 63 email only, 62 contact exists, 57 otherwise.
- annual_revenue: use 2=1-10M USD, 3=10-100M, 4=100-1000M, 5=1-10B. Use 0 if below 1M USD or unknown.

Return JSON:
{
  "industry": 11,
  "annual_revenue": 0,
  "employee_count": 0,
  "employees_category": 0,
  "icp": 66,
  "ownership": 1016,
  "icp_type": 1028,
  "qualify_status": 57,
  "org_source": 546,
  "icp_ecosystem": 0,
  "his_identification": 851,
  "company_legal_name": "",
  "his_software_name": "",
  "ceo_name": "",
  "address": "",
  "vat": "",
  "registration_number": "",
  "krs_number": "",
  "phone": "",
  "email": "",
  "number_of_beds": 0,
  "number_of_branches": 0,
  "number_of_specialists": 0,
  "company_overview": ""
}`;

    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 1000,
        response_format: { type: 'json_object' }
      })
    });

    const aiData = await aiRes.json().catch(() => ({}));
    console.log('OpenAI status:', aiRes.status);

    if (aiRes.status === 401) {
      return fail(200, 'OPENAI_KEY_INVALID', 'OpenAI API key invalid or expired.', 'Check OPENAI_API_KEY in Vercel env vars, then redeploy.', errorBase);
    }

    if (aiRes.status === 429) {
      return fail(
        200,
        'OPENAI_CREDIT_LIMIT_DELETED',
        'Credit limit deleated, contact petras to add more.',
        'OpenAI quota/rate limit reached. Contact Petras to add more credit or check platform.openai.com/usage.',
        { ...errorBase, openai_error: aiData.error?.message || null }
      );
    }

    if (aiRes.status === 400) {
      return fail(
        200,
        'OPENAI_BAD_REQUEST',
        `OpenAI bad request: ${aiData.error?.message || 'Unknown error'}`,
        'Most likely prompt too large, wrong model name, or unsupported response_format. Check OPENAI_MODEL and Vercel logs.',
        errorBase
      );
    }

    if (aiRes.status === 500 || aiRes.status === 503) {
      return fail(200, 'OPENAI_TEMPORARY_ERROR', `OpenAI temporary error ${aiRes.status}.`, 'Try again shortly. Check OpenAI status and Vercel logs if repeated.', errorBase);
    }

    if (!aiRes.ok) {
      return fail(200, 'OPENAI_UNKNOWN_ERROR', `OpenAI error ${aiRes.status}: ${aiData.error?.message || 'Unknown'}`, 'Check OpenAI logs/usage, OPENAI_API_KEY, OPENAI_MODEL, and Vercel logs.', errorBase);
    }

    const content = aiData.choices?.[0]?.message?.content || '{}';
    enriched = JSON.parse(content.replace(/```json\n?|\n?```/g, '').trim());
  } catch (error) {
    return fail(
      200,
      'AI_PARSE_OR_VERCEL_RUNTIME_ERROR',
      `AI failed: ${error.message}`,
      'Most likely: OpenAI returned invalid JSON, Vercel runtime problem, timeout, or unsupported model response. Use debug=true and check Vercel logs.',
      errorBase
    );
  }

  // Correct Polish mapping:
  // NIP   -> VAT
  // REGON -> Registration number
  // KRS   -> KRS number
  if (countryInfo?.country === 'pl') {
    if (deterministicIds.krs) enriched.krs_number = deterministicIds.krs;
    if (deterministicIds.nip) enriched.vat = deterministicIds.nip;
    if (deterministicIds.regon) enriched.registration_number = deterministicIds.regon;

    // Safety: never allow REGON and KRS mixup.
    if (
      enriched.krs_number &&
      deterministicIds.regon &&
      String(enriched.krs_number) === String(deterministicIds.regon)
    ) {
      enriched.krs_number = deterministicIds.krs || '';
      warn('POLISH_REGON_BLOCKED', 'AI tried to use REGON as KRS number. Blocked.', {
        regon: deterministicIds.regon,
        krs: deterministicIds.krs
      });
    }
  }

  const healthcareTypes = [1017, 935, 1018, 520, 932, 937, 936, 1019, 1020, 1021, 1022, 1023, 1024, 934, 931, 1025, 1026, 1027, 1029, 1030];

  if (healthcareTypes.includes(enriched.icp_type)) enriched.icp = 64;

  if (enriched.icp_type === 939) enriched.icp_ecosystem = 855;
  else if (healthcareTypes.includes(enriched.icp_type)) enriched.icp_ecosystem = 854;
  else enriched.icp_ecosystem = null;

  if (isPrivateLegalForm(name) && enriched.ownership === 1016) enriched.ownership = 1014;

  if (Number(enriched.employee_count) > 0) {
    enriched.employees_category = employeesToCategory(enriched.employee_count);
  } else if (Number(existing.employee_count) > 0 && isEmptyAI(enriched.employees_category)) {
    enriched.employees_category = employeesToCategory(existing.employee_count);
  }

  async function validateLinkedIn(url) {
    if (!url) return '';
    const clean = safeString(url).split('?')[0].replace(/\/$/, '');
    if (!clean.includes('linkedin.com/company/')) return '';
    const slug = clean.split('linkedin.com/company/')[1]?.split('/')[0];
    if (!slug || ['unavailable', 'login', 'authwall', '404', 'null', 'undefined', 'company'].includes(slug.toLowerCase())) return '';
    return `https://www.linkedin.com/company/${slug}/`;
  }

  const finalLinkedin = await validateLinkedIn(foundLinkedinUrl);

  // Auto-detect the Pipedrive custom field key for "KRS number" if env var is not set.
  // This fixes the case where KRS is found but only saved into "Registration number".
  let orgFieldHints = [];
  if (!FIELD.krs_number || debugMode) {
    try {
      const orgFields = await getPipedriveOrgFields();
      orgFieldHints = orgFields
        .filter((field) => /krs|vat|registration|regon|nip/i.test(field.name || ''))
        .map((field) => ({ name: field.name, key: field.key, field_type: field.field_type }));

      const krsField = orgFields.find((field) => {
        const fieldName = safeString(field.name).toLowerCase();
        return fieldName === 'krs number' || fieldName === 'krs' || fieldName.includes('krs');
      });

      if (!FIELD.krs_number && krsField?.key) {
        FIELD.krs_number = krsField.key;
        console.log('AUTO-DETECTED KRS FIELD KEY:', FIELD.krs_number, krsField.name);
      }
    } catch (error) {
      warn('KRS_FIELD_AUTODETECT_FAILED', 'Could not auto-detect KRS field key.', { message: error.message });
    }
  }

  const payload = {};
  const payloadDecisions = [];

  function rememberDecision(label, key, value, existingValue, action, reason = '') {
    payloadDecisions.push({
      label,
      key: key || '(missing key)',
      new_value: value ?? null,
      existing_value: existingValue ?? null,
      action,
      reason
    });
  }

  function setIfEmpty(key, value, existingValue, label = key) {
    if (isEmptyAI(value)) {
      rememberDecision(label, key, value, existingValue, 'skip', 'new value empty');
      return;
    }
    if (!isEmpty(existingValue)) {
      rememberDecision(label, key, value, existingValue, 'skip', 'existing value not empty');
      return;
    }
    payload[key] = value;
    rememberDecision(label, key, value, existingValue, 'set');
  }

  function setCfIfEmpty(key, value, existingValue, label = 'custom_field') {
    if (!key) {
      rememberDecision(label, key, value, existingValue, 'skip', 'missing field key');
      return;
    }
    if (isEmptyAI(value)) {
      rememberDecision(label, key, value, existingValue, 'skip', 'new value empty');
      return;
    }
    if (!isEmpty(existingValue)) {
      rememberDecision(label, key, value, existingValue, 'skip', 'existing value not empty');
      return;
    }
    payload[key] = value;
    rememberDecision(label, key, value, existingValue, 'set');
  }

  setIfEmpty('industry', enriched.industry, existing.industry, 'Industry');

  if (Number(enriched.annual_revenue) > 1 && (isEmpty(existing.annual_revenue) || Number(existing.annual_revenue) === 0)) {
    payload.annual_revenue = enriched.annual_revenue;
    rememberDecision('Annual revenue', 'annual_revenue', enriched.annual_revenue, existing.annual_revenue, 'set');
  }

  setIfEmpty('employee_count', Number(enriched.employee_count) > 0 ? enriched.employee_count : null, existing.employee_count, 'Employee count');
  setIfEmpty('linkedin', finalLinkedin, existing.linkedin, 'LinkedIn standard field');

  if (!isEmpty(enriched.phone) && isEmpty(existing.phone?.[0]?.value)) {
    payload.phone = [{ value: enriched.phone, primary: true, label: 'work' }];
    rememberDecision('Phone standard field', 'phone', enriched.phone, existing.phone?.[0]?.value, 'set');
  }

  if (!isEmpty(enriched.address) && isEmpty(existing.address?.value)) {
    payload.address = enriched.address;
    rememberDecision('Address standard field', 'address', enriched.address, existing.address?.value, 'set');
  }

  setCfIfEmpty(FIELD.icp, enriched.icp, existing[FIELD.icp], 'ICP');
  setCfIfEmpty(FIELD.ownership, enriched.ownership, existing[FIELD.ownership], 'Ownership');
  setCfIfEmpty(FIELD.icp_type, enriched.icp_type, existing[FIELD.icp_type], 'ICP Type');
  setCfIfEmpty(FIELD.qualify_status, enriched.qualify_status, existing[FIELD.qualify_status], 'Qualify status');
  setCfIfEmpty(FIELD.employees_category, enriched.employees_category, existing[FIELD.employees_category], 'Employees category');
  setCfIfEmpty(FIELD.org_source, enriched.org_source, existing[FIELD.org_source], 'Organization source');
  setCfIfEmpty(FIELD.icp_ecosystem, enriched.icp_ecosystem, existing[FIELD.icp_ecosystem], 'ICP ecosystem');
  setCfIfEmpty(FIELD.his_identification, enriched.his_identification, existing[FIELD.his_identification], 'HIS identification');
  setCfIfEmpty(FIELD.linkedin, finalLinkedin, existing[FIELD.linkedin], 'Company LinkedIn Profile URL');
  setCfIfEmpty(FIELD.website, website || '', existing[FIELD.website], 'Website');
  setCfIfEmpty(FIELD.phone, enriched.phone, existing[FIELD.phone], 'Phone custom field');
  setCfIfEmpty(FIELD.email, enriched.email, existing[FIELD.email], 'Company mail');
  setCfIfEmpty(FIELD.company_legal_name, enriched.company_legal_name, existing[FIELD.company_legal_name], 'Company legal name');
  setCfIfEmpty(FIELD.his_software_name, enriched.his_software_name, existing[FIELD.his_software_name], 'HIS/RIS/LIS/PACS software');
  setCfIfEmpty(FIELD.ceo_name, enriched.ceo_name, existing[FIELD.ceo_name], 'CEO for contract');
  setCfIfEmpty(FIELD.address, enriched.address, existing[FIELD.address], 'Address for license agreement');
  // VAT = Polish NIP
  setCfIfEmpty(FIELD.vat, enriched.vat || deterministicIds.nip, existing[FIELD.vat], 'VAT');

  // Registration number = Polish REGON
  setCfIfEmpty(
    FIELD.registration_number,
    enriched.registration_number || deterministicIds.regon,
    existing[FIELD.registration_number],
    'Registration number'
  );

  // KRS number = Polish KRS
  setCfIfEmpty(
    FIELD.krs_number,
    enriched.krs_number || deterministicIds.krs,
    existing[FIELD.krs_number],
    'KRS number'
  );

  if (Number(enriched.number_of_beds) > 0) setCfIfEmpty(FIELD.number_of_beds, enriched.number_of_beds, existing[FIELD.number_of_beds], 'Number of beds');
  if (Number(enriched.number_of_branches) > 0) setCfIfEmpty(FIELD.number_of_branches, enriched.number_of_branches, existing[FIELD.number_of_branches], 'Number of branches');
  if (Number(enriched.number_of_specialists) > 0) setCfIfEmpty(FIELD.number_of_specialists, enriched.number_of_specialists, existing[FIELD.number_of_specialists], 'Number of specialists');

  console.log('================ DEBUG ENRICH =================');
  console.log('COMPANY:', name);
  console.log('COUNTRY:', countryInfo);
  console.log('DETERMINISTIC IDS:', deterministicIds);
  console.log('AI RESPONSE:', JSON.stringify(enriched, null, 2));
  console.log('EXISTING VAT:', existing[FIELD.vat]);
  console.log('EXISTING REGISTRATION:', existing[FIELD.registration_number]);
  console.log('EXISTING KRS:', FIELD.krs_number ? existing[FIELD.krs_number] : 'NO KRS FIELD KEY SET');
  console.log('PAYLOAD DECISIONS:', JSON.stringify(payloadDecisions, null, 2));
  console.log('FINAL PAYLOAD:', JSON.stringify(payload, null, 2));
  console.log('================ END DEBUG =================');

  let pipedriveUpdateData = null;

  if (Object.keys(payload).length > 0) {
    try {
      const pdRes = await fetch(`https://${PD_DOMAIN}.pipedrive.com/api/v1/organizations/${organizationId}?api_token=${PD_TOKEN}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      pipedriveUpdateData = await pdRes.json().catch(() => ({}));

      if (!pdRes.ok || !pipedriveUpdateData.success) {
        return fail(
          200,
          'PIPEDRIVE_UPDATE_FAILED',
          `Pipedrive update failed. HTTP ${pdRes.status}.`,
          'Check field keys, option IDs, field types, and token permissions. See debug.payload_decisions.',
          buildBase({
            fields_attempted: Object.keys(payload),
            payload_decisions: payloadDecisions,
            pipedrive_response: debugMode ? pipedriveUpdateData : undefined,
            payload: debugMode ? payload : undefined,
            ai_response: debugMode ? enriched : undefined
          })
        );
      }
    } catch (error) {
      return fail(
        200,
        'PIPEDRIVE_UPDATE_NETWORK_OR_VERCEL_ERROR',
        `Pipedrive update request failed: ${error.message}`,
        'Most likely: Vercel network issue, Pipedrive timeout, wrong domain, or invalid token.',
        buildBase({ fields_attempted: Object.keys(payload), payload_decisions: payloadDecisions })
      );
    }
  }

  let noteAdded = false;

  if (enriched.company_overview) {
    try {
      const notesRes = await fetch(`https://${PD_DOMAIN}.pipedrive.com/api/v1/notes?api_token=${PD_TOKEN}&org_id=${organizationId}&limit=10`);
      const notesData = await notesRes.json().catch(() => ({}));
      const hasAiNote = notesData.data?.some((note) => note.content?.includes('🤖 AI Enrichment'));

      if (!hasAiNote) {
        const sources = ['Tavily web search', process.env.OPENAI_MODEL || 'OpenAI gpt-4o-mini'];
        if (countryInfo?.registries?.length) sources.push(`${countryInfo.registries.join(', ')} registry search`);
        if (foundLinkedinUrl) sources.push('LinkedIn');
        if (deterministicIds.krs || deterministicIds.nip || deterministicIds.regon) sources.push('deterministic KRS/NIP/REGON regex extraction');

        const noteContent = `🤖 AI Enrichment\n\n${enriched.company_overview}\n\n📊 Sources: ${sources.join(', ')}`;

        const createNoteRes = await fetch(`https://${PD_DOMAIN}.pipedrive.com/api/v1/notes?api_token=${PD_TOKEN}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: noteContent, org_id: organizationId })
        });

        const createNoteData = await createNoteRes.json().catch(() => ({}));
        noteAdded = !!createNoteData.success;
      }
    } catch (error) {
      warn('PIPEDRIVE_NOTE_FAILED', 'AI note step failed.', { message: error.message });
    }
  }

  const emptyImportantFields = [];
  if (!enriched.vat) emptyImportantFields.push('vat');
  if (!enriched.registration_number) emptyImportantFields.push('registration_number');
  if (!enriched.ceo_name) emptyImportantFields.push('ceo_name');
  if (!enriched.address) emptyImportantFields.push('address');

  let orgFieldHints = [];

  if (debugMode) {
    try {
      const orgFields = await getPipedriveOrgFields();
      orgFieldHints = orgFields
        .filter((field) => /krs|vat|registration|regon|nip/i.test(field.name || ''))
        .map((field) => ({ name: field.name, key: field.key, field_type: field.field_type }));
      console.log('PIPEDRIVE ORG FIELD HINTS:', JSON.stringify(orgFieldHints, null, 2));
    } catch (error) {
      warn('ORG_FIELD_HINTS_FAILED', 'Could not fetch organization field hints.', { message: error.message });
    }
  }

  let alert = null;

  if (countryInfo?.country === 'pl' && (!enriched.vat || !enriched.registration_number)) {
    alert = {
      scenario: 'POLISH_IDS_NOT_FULLY_FOUND',
      message: 'Polish enrichment finished, but KRS/NIP was not fully found.',
      solution: 'Check debug.registry_context and deterministic_ids. If official page data exists but extract is empty, Tavily cannot read the dynamic official page.'
    };
  } else if (!FIELD.krs_number && countryInfo?.country === 'pl') {
    alert = {
      scenario: 'KRS_FIELD_KEY_NOT_SET',
      message: 'KRS was found, but separate KRS field key is not configured.',
      solution: 'Run with debug=true, check debug.org_field_hints, copy the KRS number field key to Vercel env var PD_FIELD_KRS_NUMBER, then redeploy.'
    };
  } else if (Object.keys(payload).length === 0) {
    alert = {
      scenario: 'NOTHING_TO_UPDATE',
      message: 'Enrichment ran, but no empty Pipedrive fields could be filled.',
      solution: 'Fields may already be filled, existing values may not be truly empty, or field keys may be wrong. Check debug.payload_decisions.'
    };
  }

  return res.status(200).json({
    success: true,
    fields_filled: Object.keys(payload).length,
    fields_attempted: Object.keys(payload),
    tavily_used: !!searchContext,
    registry_used: !!registryContext,
    registry_urls: registryUrls,
    linkedin_found: !!finalLinkedin,
    deterministic_ids: deterministicIds,
    empty_important_fields: emptyImportantFields,
    alert,
    warnings,
    note_added: noteAdded,
    runtime_ms: Date.now() - startedAt,
    ...(debugMode && {
      debug: {
        country_info: countryInfo,
        registry_context: registryContext.substring(0, 3000),
        search_context: searchContext.substring(0, 2000),
        ai_response: enriched,
        payload,
        payload_decisions: payloadDecisions,
        org_field_hints: orgFieldHints,
        pipedrive_update_response: pipedriveUpdateData
      }
    })
  });
}
