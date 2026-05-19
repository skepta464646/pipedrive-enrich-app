export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { organizationId } = req.body;
  let { name, website } = req.body;
  if (!organizationId) return res.status(400).json({ error: 'Missing organizationId' });

  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  const PD_TOKEN = process.env.PIPEDRIVE_API_TOKEN;
  const PD_DOMAIN = process.env.PIPEDRIVE_DOMAIN;
  const TAVILY_KEY = process.env.TAVILY_API_KEY;

  // ─── Step 0: Get existing org from Pipedrive ──────────────────────────────
  let existing = {};
  try {
    const r = await fetch(`https://${PD_DOMAIN}.pipedrive.com/api/v1/organizations/${organizationId}?api_token=${PD_TOKEN}`);
    const d = await r.json();
    if (d.success) {
      existing = d.data || {};
      if (!name) name = existing.name || '';
      if (!website) website = existing.website || existing['783923cad610ca666dc3ddac86085a6468c7b809'] || '';
    }
  } catch (e) { console.error('PD fetch error:', e.message); }

  const isEmpty = (val) => val === null || val === undefined || val === '';
  const isEmptyAI = (val) => val === null || val === undefined || val === '' || val === 0;

  // ─── Helper: employees count → category ID ────────────────────────────────
  function employeesToCategory(count) {
    if (!count || count <= 0) return 0;
    if (count <= 10) return 49;
    if (count <= 50) return 50;
    if (count <= 200) return 51;
    if (count <= 500) return 52;
    if (count <= 1000) return 53;
    if (count <= 5000) return 54;
    if (count <= 10000) return 55;
    return 56;
  }

  // ─── Helper: detect country registry from website/name ───────────────────
  function getCountryRegistry(websiteUrl, companyName) {
    const domain = websiteUrl?.toLowerCase() || '';
    const nameLower = companyName?.toLowerCase() || '';
    if (domain.includes('.lt') || nameLower.includes(', uab') || nameLower.includes(', ab') || nameLower.includes(', vi') || nameLower.includes(', mb'))
      return { country: 'lt', registry: 'rekvizitai.lt' };
    if (domain.includes('.pl') || nameLower.includes(' sp. z o.o') || nameLower.includes(' s.a.') || nameLower.includes(' sp.k') || nameLower.includes('spolka'))
      return { country: 'pl', registry: 'aleo.com' };
    if (domain.includes('.se') || nameLower.includes(' ab ') || nameLower.endsWith(' ab'))
      return { country: 'se', registry: 'allabolag.se' };
    if (domain.includes('.de') || nameLower.includes(' gmbh') || nameLower.includes(' ag '))
      return { country: 'de', registry: 'northdata.com' };
    if (domain.includes('.gr'))
      return { country: 'gr', registry: 'businessregistry.gr' };
    if (domain.includes('.pt') || nameLower.includes(' lda') || nameLower.includes(', lda'))
      return { country: 'pt', registry: 'racius.pt' };
    if (domain.includes('.fi') || nameLower.includes(' oy ') || nameLower.endsWith(' oy') || nameLower.includes(' oyj'))
      return { country: 'fi', registry: 'finder.fi' };
    if (domain.includes('.no') || nameLower.includes(' as ') || nameLower.endsWith(' as') || nameLower.includes(' asa'))
      return { country: 'no', registry: 'proff.no' };
    if (domain.includes('.dk') || nameLower.includes(' a/s') || nameLower.includes(' aps'))
      return { country: 'dk', registry: 'cvr.dk' };
    if (domain.includes('.nl') || nameLower.includes(' b.v.') || nameLower.includes(' n.v.'))
      return { country: 'nl', registry: 'kvk.nl' };
    if (domain.includes('.cz') || nameLower.includes(' s.r.o') || nameLower.includes(' a.s.'))
      return { country: 'cz', registry: 'rejstrik.penize.cz' };
    if (domain.includes('.hu') || nameLower.includes(' kft') || nameLower.includes(' zrt'))
      return { country: 'hu', registry: 'e-cegjegyzek.hu' };
    if (domain.includes('.ro') || nameLower.includes(' srl ') || nameLower.endsWith(' srl'))
      return { country: 'ro', registry: 'listafirme.ro' };
    if (domain.includes('.bg'))
      return { country: 'bg', registry: 'papagal.bg' };
    if (domain.includes('.hr') || nameLower.includes(' d.o.o') || nameLower.includes(' d.d.'))
      return { country: 'hr', registry: 'fininfo.hr' };
    if (domain.includes('.ee') || nameLower.includes(' oü'))
      return { country: 'ee', registry: 'teatmik.ee' };
    if (domain.includes('.lv') || nameLower.includes(' sia ') || nameLower.endsWith(' sia'))
      return { country: 'lv', registry: 'lursoft.lv' };
    if (domain.includes('.com.tr') || domain.includes('.tr'))
      return { country: 'tr', registry: 'sirketbilgileri.com' };
    return null;
  }

  // ─── Helper: detect private ownership from legal form ────────────────────
  function isPrivateLegalForm(companyName) {
    const n = companyName?.toLowerCase() || '';
    const privateForms = [', uab', ', mb', ' sp. z o.o', ' s.r.o', ' gmbh', ' b.v.', ', lda', ' kft', ' oü', ' sia', ' srl', ' d.o.o', ' aps', ' bv', ' sas', ' sarl', 'spolka z ograniczona'];
    return privateForms.some(f => n.includes(f));
  }

  // ─── Step 1: Tavily search ────────────────────────────────────────────────
  let searchContext = '';
  let foundLinkedinUrl = '';
  let registryContext = '';

  if (TAVILY_KEY && name) {
    try {
      const countryInfo = getCountryRegistry(website, name);

      // Build registry query — use domain if available (more reliable than org name)
      const websiteDomain = website
        ? website.replace(/https?:\/\/(www\.)?/, '').split('/')[0].trim()
        : '';
      const registryQuery = websiteDomain
        ? `${websiteDomain} site:${countryInfo?.registry}`
        : `"${name}" site:${countryInfo?.registry}`;

      const searchQueries = [
        fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: TAVILY_KEY,
            query: `${name} ${website || ''} company healthcare contact phone email address`,
            search_depth: 'basic',
            max_results: 3,
            include_answer: true
          })
        }),
        fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: TAVILY_KEY,
            query: `"${name}" site:linkedin.com/company`,
            search_depth: 'basic',
            max_results: 3,
            include_answer: false
          })
        })
      ];

      if (countryInfo) {
        searchQueries.push(
          fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              api_key: TAVILY_KEY,
              query: registryQuery,
              search_depth: 'basic',
              max_results: 2,
              include_answer: false
            })
          })
        );
      }

      const responses = await Promise.all(searchQueries);
      const [generalData, linkedinData, registryData] = await Promise.all(responses.map(r => r.json()));

      if (generalData.answer) searchContext += `Summary: ${generalData.answer}\n\n`;
      if (generalData.results?.length > 0) {
        searchContext += 'Web results:\n';
        generalData.results.forEach(r => {
          searchContext += `- ${r.title}: ${r.content?.substring(0, 200)}\n`;
        });
      }

      // Registry: snippets + full extract
      if (registryData?.results?.length > 0) {
        registryContext += `\nOfficial registry (${countryInfo.registry}):\n`;
        registryData.results.forEach(r => {
          registryContext += `- ${r.title}: ${r.content?.substring(0, 200)}\n`;
        });
        // Extract full content from first registry result
        try {
          const regExtractRes = await fetch('https://api.tavily.com/extract', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_key: TAVILY_KEY, urls: [registryData.results[0].url] })
          });
          const regExtractData = await regExtractRes.json();
          const regContent = regExtractData.results?.[0]?.raw_content || '';
          if (regContent) registryContext += `\nFull registry data:\n${regContent.substring(0, 1500)}\n`;
        } catch { console.log('Registry extract failed'); }
        searchContext += registryContext;
        console.log('Registry found:', countryInfo.registry, '| query:', registryQuery);
      }

      // LinkedIn validation
      const liResult = linkedinData.results?.find(r => r.url?.includes('linkedin.com/company/'));
      if (liResult) {
        const nameWords = name.toLowerCase().split(/\s+/).filter(w => w.length > 3);
        const titleMatches = nameWords.some(w => liResult.title?.toLowerCase().includes(w));
        if (titleMatches) {
          try {
            const extractRes = await fetch('https://api.tavily.com/extract', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ api_key: TAVILY_KEY, urls: [liResult.url] })
            });
            const extractData = await extractRes.json();
            const liContent = extractData.results?.[0]?.raw_content || '';
            const cleanWebsite = website?.replace(/https?:\/\/(www\.)?/, '').replace(/\/$/, '') || '';
            const websiteMatch = cleanWebsite && liContent.toLowerCase().includes(cleanWebsite.toLowerCase());
            if (websiteMatch) {
              foundLinkedinUrl = liResult.url;
              searchContext += `\nLinkedIn: ${liResult.url}`;
            }
          } catch { console.log('LinkedIn extract failed'); }
        }
      }
    } catch (e) { console.error('Tavily error:', e.message); }
  }

  // ─── Step 2: AI enrichment with Gemini ───────────────────────────────────
  searchContext = searchContext.slice(0, 3000);
  let enriched = {};
  try {
    const prompt = `You are a B2B healthcare CRM specialist. Return ONLY valid JSON, no markdown, no explanation.

Enrich this company:
Name: ${name}
Website: ${website || 'unknown'}
Address: ${existing.address?.value || 'unknown'}
${searchContext ? `\nContext (includes official registry data if available):\n${searchContext}` : ''}

IMPORTANT:
- License Agreement fields: fill ONLY from official registry or website sources in context. Leave "" if not found.
- ceo_name: extract from registry (look for "Vadovas", "Director", "CEO", "President of the Management Board", "Prezes Zarządu")
- vat: extract TAX ID / NIP / VAT number from registry
- registration_number: extract KRS / National Court Register number from registry (NOT REGON)
- address: extract legal/registered address from registry
- qualify_status: set based on contact info found (phone/email)
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
  "phone": "",
  "email": "",
  "number_of_beds": 0,
  "number_of_branches": 0,
  "number_of_specialists": 0,
  "company_overview": ""
}

ID mappings:
industry: 11=Healthcare, 14=Professional Services, 17=Technology
annual_revenue: 2=1-10M USD, 3=10-100M USD, 4=100-1000M USD, 5=1-10B USD. Use 0 if below 1M or unknown.
employees_category: 49=1-10, 50=11-50, 51=51-200, 52=201-500, 53=501-1000, 54=1001-5000, 55=5001-10000, 56=10001+
icp: 64=Yes, 65=No, 371=No-too-small, 66=Unknown
ownership: 1014=Private, 1015=Public, 1016=Unknown
icp_type: 1017=Hospital, 935=Clinic/Polyclinic, 1018=Specialist Practice, 520=Dental Clinic, 932=Diagnostic Center, 939=HIS Software Provider, 937=Nursing Home, 936=Dialysis Clinic, 1019=Physiotherapy Clinic, 1020=Aesthetic Surgery Clinic, 1021=Ophthalmology Clinic, 1022=Radiology Center, 1023=Rehabilitation Center, 1024=Mental Health Clinic, 934=Maternity/IVF Clinic, 931=Home Care, 1025=Government Health Center, 1026=University/Teaching Hospital, 1027=Non-Profit/NGO, 1029=Occupational Health Center, 1030=Hospice/Palliative Care, 1028=Unknown
qualify_status: 57=To qualify, 61=Qualified no contact, 62=Qualified with contact, 63=Qualified with contact+email, 724=Qualified with contact+email+phone, 725=Qualified with contact+phone
org_source: always 546
icp_ecosystem: 854=Healthcare ecosystem, 855=Healthcare software vendors, 0=not applicable
his_identification: 850=Yes, 851=No`;

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 800 }
        })
      }
    );

    const geminiData = await geminiRes.json();
    console.log('Gemini status:', geminiRes.status);

    if (geminiRes.status === 401 || geminiRes.status === 403)
      return res.status(200).json({ success: false, error: '❌ Gemini API key invalid. Update GEMINI_API_KEY in Vercel.', fields_filled: 0 });
    if (geminiRes.status === 429)
      return res.status(200).json({ success: false, error: '⏳ Gemini rate limit reached. Try again in a minute.', fields_filled: 0 });
    if (!geminiRes.ok)
      return res.status(200).json({ success: false, error: '❌ Gemini error ' + geminiRes.status + ': ' + (geminiData.error?.message || ''), fields_filled: 0 });

    const content = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    console.log('Gemini content:', content.substring(0, 300));
    enriched = JSON.parse(content.replace(/```json\n?|\n?```/g, '').trim());
  } catch (e) {
    console.error('AI failed:', e.message);
    return res.status(500).json({ error: 'AI failed: ' + e.message });
  }

  console.log('AI response:', JSON.stringify(enriched));

  // ─── Step 3: Auto-corrections ─────────────────────────────────────────────
  const healthcareTypes = [1017,935,1018,520,932,937,936,1019,1020,1021,1022,1023,1024,934,931,1025,1026,1027,1029,1030];

  if (healthcareTypes.includes(enriched.icp_type) && (enriched.icp === 66 || enriched.icp === 0))
    enriched.icp = 64;

  if (enriched.icp_type === 939) enriched.icp_ecosystem = 855;
  else if (healthcareTypes.includes(enriched.icp_type)) enriched.icp_ecosystem = 854;
  else enriched.icp_ecosystem = null;

  if (isPrivateLegalForm(name) && enriched.ownership === 1016)
    enriched.ownership = 1014;

  if (enriched.employee_count > 0)
    enriched.employees_category = employeesToCategory(enriched.employee_count);
  else if (existing.employee_count > 0 && isEmptyAI(enriched.employees_category))
    enriched.employees_category = employeesToCategory(existing.employee_count);

  // ─── Step 4: Validate LinkedIn ────────────────────────────────────────────
  const INVALID_SLUGS = ['unavailable','login','authwall','404','null','undefined','company'];
  async function validateLinkedIn(url) {
    if (!url) return '';
    const clean = url.trim().split('?')[0].replace(/\/$/, '');
    if (!clean.includes('linkedin.com/company/')) return '';
    const slug = clean.split('linkedin.com/company/')[1]?.split('/')[0];
    if (!slug || INVALID_SLUGS.includes(slug.toLowerCase())) return '';
    const finalUrl = `https://www.linkedin.com/company/${slug}/`;
    try {
      const r = await fetch(finalUrl, { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000), redirect: 'follow' });
      if (r.status === 404 || r.url?.includes('unavailable')) return '';
      return finalUrl;
    } catch { return finalUrl; }
  }

  const finalLinkedin = await validateLinkedIn(foundLinkedinUrl);

  // ─── Step 5: Build payload — only empty fields ────────────────────────────
  const payload = {};
  const setIfEmpty = (key, val, ev) => { if (!isEmptyAI(val) && isEmpty(ev)) payload[key] = val; };
  const setCfIfEmpty = (hash, val, ev) => { if (!isEmptyAI(val) && isEmpty(ev)) payload[hash] = val; };

  setIfEmpty('industry', enriched.industry, existing.industry);
  if (enriched.annual_revenue > 1 && (isEmpty(existing.annual_revenue) || existing.annual_revenue === 0))
    payload.annual_revenue = enriched.annual_revenue;
  setIfEmpty('employee_count', enriched.employee_count > 0 ? enriched.employee_count : null, existing.employee_count);
  setIfEmpty('linkedin', finalLinkedin, existing.linkedin);
  if (!isEmpty(enriched.phone) && isEmpty(existing.phone?.[0]?.value))
    payload.phone = [{ value: enriched.phone, primary: true, label: 'work' }];
  if (!isEmpty(enriched.address) && isEmpty(existing.address?.value))
    payload.address = enriched.address;

  setCfIfEmpty('0d5afcefbd6ada8781d38fe74873d4b308234a49', enriched.icp,               existing['0d5afcefbd6ada8781d38fe74873d4b308234a49']);
  setCfIfEmpty('5b6f71999f89a4ac00ed32f8bd49bc8480bf459d', enriched.ownership,          existing['5b6f71999f89a4ac00ed32f8bd49bc8480bf459d']);
  setCfIfEmpty('ef79b1ce2c6860be02443dd9728ad62dd4f8b18c', enriched.icp_type,           existing['ef79b1ce2c6860be02443dd9728ad62dd4f8b18c']);
  setCfIfEmpty('18ba6331d70bcfa1eb8cf977c52948c4f2b53df3', enriched.qualify_status,     existing['18ba6331d70bcfa1eb8cf977c52948c4f2b53df3']);
  setCfIfEmpty('113a8ed69dfd080a7d1b84392251a3474d989216', enriched.employees_category, existing['113a8ed69dfd080a7d1b84392251a3474d989216']);
  setCfIfEmpty('95d37d3df1ed511ae90f7fac64eac37a20f4ed83', enriched.org_source,         existing['95d37d3df1ed511ae90f7fac64eac37a20f4ed83']);
  setCfIfEmpty('e37b931ae0af55393fc51f1b2135c2355b4bea12', enriched.icp_ecosystem,      existing['e37b931ae0af55393fc51f1b2135c2355b4bea12']);
  setCfIfEmpty('bb5ec6a8351b0d3423011da1f8dbfd89d8590b27', enriched.his_identification, existing['bb5ec6a8351b0d3423011da1f8dbfd89d8590b27']);
  setCfIfEmpty('0139565cc0f6a8dcc0cae8244b672600adf64860', finalLinkedin,               existing['0139565cc0f6a8dcc0cae8244b672600adf64860']);
  setCfIfEmpty('783923cad610ca666dc3ddac86085a6468c7b809', website || '',               existing['783923cad610ca666dc3ddac86085a6468c7b809']);
  setCfIfEmpty('99c1cffae1ed208819f80c4c3a1b545d461082bb', enriched.phone,              existing['99c1cffae1ed208819f80c4c3a1b545d461082bb']);
  setCfIfEmpty('b83bf5f8378a2275b475db4dc64b1101ea48836a', enriched.email,              existing['b83bf5f8378a2275b475db4dc64b1101ea48836a']);
  setCfIfEmpty('b4c2b2ef4b92a130ec7de91f4d17622d5640431e', enriched.company_legal_name, existing['b4c2b2ef4b92a130ec7de91f4d17622d5640431e']);
  setCfIfEmpty('115cfff712c6caf184d7c155838a9dace81e8821', enriched.his_software_name,  existing['115cfff712c6caf184d7c155838a9dace81e8821']);
  setCfIfEmpty('4107458f7b06285686f1968fbefa9ea50902cf07', enriched.ceo_name,           existing['4107458f7b06285686f1968fbefa9ea50902cf07']);
  setCfIfEmpty('6d64ec2abf8d9a01a64c0cbf2f962281845b1c85', enriched.address,            existing['6d64ec2abf8d9a01a64c0cbf2f962281845b1c85']);
  setCfIfEmpty('aa9502b251dece8bf94fd779579676f711c7c17d', enriched.vat,                existing['aa9502b251dece8bf94fd779579676f711c7c17d']);
  setCfIfEmpty('0d6adf6f65d52b61826d207cc40357265b6d6402', enriched.registration_number, existing['0d6adf6f65d52b61826d207cc40357265b6d6402']);
  if (enriched.number_of_beds > 0 && isEmpty(existing['03ed00fa62b2687bb7ec4a2b6c3194cc828d81db']))
    payload['03ed00fa62b2687bb7ec4a2b6c3194cc828d81db'] = enriched.number_of_beds;
  if (enriched.number_of_branches > 0 && isEmpty(existing['bdc6f4f7031fa45a45aa4cd4cd3014f66f9847cf']))
    payload['bdc6f4f7031fa45a45aa4cd4cd3014f66f9847cf'] = enriched.number_of_branches;
  if (enriched.number_of_specialists > 0 && isEmpty(existing['598c7ea3d04ce28a52985dc15a7f74cb6ff977f3']))
    payload['598c7ea3d04ce28a52985dc15a7f74cb6ff977f3'] = enriched.number_of_specialists;

  console.log('Payload keys:', Object.keys(payload));

  // ─── Step 6: Update Pipedrive ─────────────────────────────────────────────
  if (Object.keys(payload).length > 0) {
    const pdRes = await fetch(
      `https://${PD_DOMAIN}.pipedrive.com/api/v1/organizations/${organizationId}?api_token=${PD_TOKEN}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
    );
    const pdData = await pdRes.json();
    if (!pdData.success) console.error('Pipedrive error:', JSON.stringify(pdData));
  }

  // ─── Step 7: Add note with sources ───────────────────────────────────────
  if (enriched.company_overview) {
    const notesRes = await fetch(`https://${PD_DOMAIN}.pipedrive.com/api/v1/notes?api_token=${PD_TOKEN}&org_id=${organizationId}&limit=10`).then(r => r.json());
    const hasAiNote = notesRes.data?.some(n => n.content?.includes('🤖 AI Enrichment'));
    if (!hasAiNote) {
      const countryInfo = getCountryRegistry(website, name);
      const sources = ['Tavily web search', 'Gemini AI'];
      if (countryInfo) sources.push(`${countryInfo.registry} (official registry)`);
      if (foundLinkedinUrl) sources.push('LinkedIn');
      const noteContent = `🤖 AI Enrichment\n\n${enriched.company_overview}\n\n📊 Sources: ${sources.join(', ')}`;
      await fetch(`https://${PD_DOMAIN}.pipedrive.com/api/v1/notes?api_token=${PD_TOKEN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: noteContent, org_id: organizationId })
      });
    }
  }

  return res.status(200).json({
    success: true,
    fields_filled: Object.keys(payload).length,
    tavily_used: !!searchContext,
    linkedin_found: !!finalLinkedin,
    registry_used: !!registryContext
  });
}
