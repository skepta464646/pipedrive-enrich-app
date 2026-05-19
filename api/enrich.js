export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { organizationId } = req.body;
  let { name, website } = req.body;
  if (!organizationId) return res.status(400).json({ error: 'Missing organizationId' });

  const GROQ_KEY = process.env.GROQ_API_KEY;
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

  const isEmpty = (val) => val === null || val === undefined || val === '' || val === 0 || val === false;

  // ─── Step 1: Tavily search ────────────────────────────────────────────────
  let searchContext = '';
  let foundLinkedinUrl = '';

  if (TAVILY_KEY && name) {
    try {
      const [generalRes, linkedinRes] = await Promise.all([
        fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: TAVILY_KEY,
            query: `${name} ${website || ''} company healthcare contact phone`,
            search_depth: 'basic',
            max_results: 4,
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
      ]);

      const [generalData, linkedinData] = await Promise.all([
        generalRes.json(),
        linkedinRes.json()
      ]);

      if (generalData.answer) searchContext += `Summary: ${generalData.answer}\n\n`;
      if (generalData.results?.length > 0) {
        searchContext += 'Web results:\n';
        generalData.results.slice(0, 3).forEach(r => {
          searchContext += `- ${r.title}: ${r.content?.substring(0, 200)}\n`;
        });
      }

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

  // ─── Step 2: AI enrichment ────────────────────────────────────────────────
  searchContext = searchContext.slice(0, 1500);
  let enriched = {};
  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        max_tokens: 800,
        messages: [
          {
            role: 'system',
            content: 'You are a B2B healthcare CRM specialist. Return ONLY valid JSON, no markdown, no explanation. Use numeric IDs as specified.'
          },
          {
            role: 'user',
            content: `Enrich this company for CRM:
Name: ${name}
Website: ${website || 'unknown'}
Address: ${existing.address?.value || 'unknown'}
${searchContext ? `\nContext:\n${searchContext}` : ''}

Return JSON with these exact fields and numeric IDs:
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
annual_revenue: 2=1-10M, 3=10-100M, 4=100-1000M, 5=1-10B
employees_category: 49=1-10, 50=11-50, 51=51-200, 52=201-500, 53=501-1000, 54=1001-5000, 55=5001-10000, 56=10001+
icp: 64=Yes, 65=No, 371=No-too-small, 66=Unknown
ownership: 1014=Private, 1015=Public, 1016=Unknown
icp_type: 1017=Hospital, 935=Clinic, 1018=Specialist, 520=Dental, 932=Diagnostic, 939=HIS Software, 937=Nursing Home, 936=Dialysis, 1019=Physio, 1020=Aesthetic, 1021=Ophthalmology, 1022=Radiology, 1023=Rehab, 1024=Mental Health, 934=Maternity/IVF, 931=Home Care, 1028=Unknown
qualify_status: 62=Has contact, 63=Has contact+email, 61=No contact, 57=To qualify
icp_ecosystem: 854=Healthcare, 855=HIS Software vendors
his_identification: 850=Yes, 851=No

Fill what you can determine. Use defaults (0, 66, 1016, etc.) for unknowns.`
          }
        ]
      })
    });

    const groqData = await groqRes.json();
    console.log('Groq status:', groqRes.status, JSON.stringify(groqData.error || ''));
    const content = groqData.choices?.[0]?.message?.content || '{}';
    console.log('Groq content:', content.substring(0, 200));
    enriched = JSON.parse(content.replace(/```json\n?|\n?```/g, '').trim());
  } catch (e) {
    console.error('AI failed:', e.message);
    return res.status(500).json({ error: 'AI failed: ' + e.message });
  }

  console.log('AI response:', JSON.stringify(enriched));

  // ─── Step 3: Auto-corrections ─────────────────────────────────────────────
  const healthcareTypes = [1017,935,1018,520,932,937,936,1019,1020,1021,1022,1023,1024,934,931];
  if (healthcareTypes.includes(enriched.icp_type) && (enriched.icp === 66 || enriched.icp === 0)) {
    enriched.icp = 64;
  }
  if (enriched.icp_type === 939 && !enriched.icp_ecosystem) enriched.icp_ecosystem = 855;
  if (healthcareTypes.includes(enriched.icp_type) && !enriched.icp_ecosystem) enriched.icp_ecosystem = 854;

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
  const cf = existing.custom_fields || {};
  const payload = {};
  const setIfEmpty = (key, val, ev) => { if (!isEmpty(val) && isEmpty(ev)) payload[key] = val; };
  const setCfIfEmpty = (hash, val, ev) => { if (!isEmpty(val) && isEmpty(ev)) payload[hash] = val; };

  setIfEmpty('industry', enriched.industry, existing.industry);
  setIfEmpty('annual_revenue', enriched.annual_revenue > 1 ? enriched.annual_revenue : null, existing.annual_revenue);
  setIfEmpty('employee_count', enriched.employee_count > 0 ? enriched.employee_count : null, existing.employee_count);
  setIfEmpty('linkedin', finalLinkedin, existing.linkedin);
  if (!isEmpty(enriched.phone) && isEmpty(existing.phone?.[0]?.value)) payload.phone = [{ value: enriched.phone, primary: true, label: 'work' }];
  if (!isEmpty(enriched.address) && isEmpty(existing.address?.value)) payload.address = { value: enriched.address };

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
  setCfIfEmpty('99c1cffae1ed208819f80c4c3a1b545d461082bb', enriched.phone,             existing['99c1cffae1ed208819f80c4c3a1b545d461082bb']);
  setCfIfEmpty('b83bf5f8378a2275b475db4dc64b1101ea48836a', enriched.email,             existing['b83bf5f8378a2275b475db4dc64b1101ea48836a']);
  setCfIfEmpty('b4c2b2ef4b92a130ec7de91f4d17622d5640431e', enriched.company_legal_name,existing['b4c2b2ef4b92a130ec7de91f4d17622d5640431e']);
  setCfIfEmpty('115cfff712c6caf184d7c155838a9dace81e8821', enriched.his_software_name, existing['115cfff712c6caf184d7c155838a9dace81e8821']);
  setCfIfEmpty('4107458f7b06285686f1968fbefa9ea50902cf07', enriched.ceo_name,          existing['4107458f7b06285686f1968fbefa9ea50902cf07']);
  setCfIfEmpty('6d64ec2abf8d9a01a64c0cbf2f962281845b1c85', enriched.address,           existing['6d64ec2abf8d9a01a64c0cbf2f962281845b1c85']);
  setCfIfEmpty('aa9502b251dece8bf94fd779579676f711c7c17d', enriched.vat,               existing['aa9502b251dece8bf94fd779579676f711c7c17d']);
  setCfIfEmpty('0d6adf6f65d52b61826d207cc40357265b6d6402', enriched.registration_number,existing['0d6adf6f65d52b61826d207cc40357265b6d6402']);
  if (enriched.number_of_beds > 0 && isEmpty(existing['03ed00fa62b2687bb7ec4a2b6c3194cc828d81db'])) payload['03ed00fa62b2687bb7ec4a2b6c3194cc828d81db'] = enriched.number_of_beds;
  if (enriched.number_of_branches > 0 && isEmpty(existing['bdc6f4f7031fa45a45aa4cd4cd3014f66f9847cf'])) payload['bdc6f4f7031fa45a45aa4cd4cd3014f66f9847cf'] = enriched.number_of_branches;
  if (enriched.number_of_specialists > 0 && isEmpty(existing['598c7ea3d04ce28a52985dc15a7f74cb6ff977f3'])) payload['598c7ea3d04ce28a52985dc15a7f74cb6ff977f3'] = enriched.number_of_specialists;

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

  // ─── Step 7: Add note ─────────────────────────────────────────────────────
  if (enriched.company_overview) {
    const notesRes = await fetch(`https://${PD_DOMAIN}.pipedrive.com/api/v1/notes?api_token=${PD_TOKEN}&org_id=${organizationId}&limit=10`).then(r => r.json());
    const hasAiNote = notesRes.data?.some(n => n.content?.includes('🤖 AI Enrichment'));
    if (!hasAiNote) {
      await fetch(`https://${PD_DOMAIN}.pipedrive.com/api/v1/notes?api_token=${PD_TOKEN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: `🤖 AI Enrichment\n\n${enriched.company_overview}`, org_id: organizationId })
      });
    }
  }

  return res.status(200).json({
    success: true,
    fields_filled: Object.keys(payload).length,
    tavily_used: !!searchContext,
    linkedin_found: !!finalLinkedin
  });
}
