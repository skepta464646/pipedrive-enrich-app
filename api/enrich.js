export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { organizationId, name, website } = req.body;
  if (!organizationId || !name) return res.status(400).json({ error: 'Missing organizationId or name' });

  const GROQ_KEY = process.env.GROQ_API_KEY;
  const PD_TOKEN = process.env.PIPEDRIVE_API_TOKEN;
  const PD_DOMAIN = process.env.PIPEDRIVE_DOMAIN;

  // ─── Step 1: Scrape website ───────────────────────────────────────────────
  let scraped = { email: '', linkedin: '', phone: '', html_text: '' };

  if (website) {
    try {
      const r = await fetch(website, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(10000)
      });
      const html = await r.text();

      const text = html.replace(/<script[\s\S]*?<\/script>/gi, '')
                       .replace(/<style[\s\S]*?<\/style>/gi, '')
                       .replace(/<[^>]+>/g, ' ')
                       .replace(/\s+/g, ' ')
                       .substring(0, 4000);

      // Emails
      const genericDomains = ['gmail','yahoo','hotmail','outlook','example','sentry','wix','wp','noreply','cloudflare','w3.org','schema'];
      const emails = [...new Set((html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [])
        .filter(e => !genericDomains.some(d => e.toLowerCase().includes(d))))];

      // LinkedIn company URL
      const linkedinMatch = html.match(/https?:\/\/(www\.)?linkedin\.com\/company\/[a-zA-Z0-9_%-]+/i);

      // Phone - strict pattern: must start with + or have country code format
      const phoneMatches = html.match(/(\+[\d\s\-().]{8,18}[\d])/g) || [];
      const cleanPhone = phoneMatches
        .map(p => p.trim().replace(/\s+/g, ' '))
        .filter(p => {
          const digits = p.replace(/\D/g, '');
          return digits.length >= 8 && digits.length <= 15;
        })[0] || '';

      scraped = {
        email: emails[0] || '',
        linkedin: linkedinMatch?.[0]?.split('?')[0] || '',
        phone: cleanPhone,
        html_text: text
      };
    } catch (e) {
      console.error('Scraping error:', e.message);
    }
  }

  // ─── Step 2: AI enrichment ────────────────────────────────────────────────
  let enriched = {};
  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 1200,
        messages: [{
          role: 'user',
          content: `You are a B2B healthcare CRM data specialist. Analyze this company carefully and fill ALL fields you can determine with HIGH confidence. Do not guess - leave empty string or 0 if unsure.

Company name: ${name}
Website: ${website || 'unknown'}
Website content: ${scraped.html_text || 'not available'}
Found email: ${scraped.email || 'none'}
Found phone: ${scraped.phone || 'none'}

Return ONLY valid JSON (no markdown, no explanation):
{
  "industry": <11=Hospitals & Health Care, 14=Professional Services, 17=Technology, 12=Manufacturing, 16=Retail, 18=Transportation, or 0 if unknown>,
  "annual_revenue": <1=under 1M, 2=1-10M USD, 3=10-100M USD, 4=100-1000M USD, 5=1-10B USD, or 0 if unknown>,
  "employee_count": <exact number if known from website content, or 0>,
  "employees_category": <49=1-10, 50=11-50, 51=51-200, 52=201-500, 53=501-1000, 54=1001-5000, 55=5001-10000, 56=10001+, or 0 if unknown>,
  "icp": <64=Yes, 65=No, 371=No-too small, 66=?, default 66>,
  "ownership": <1014=Private, 1015=Public, 1016=Unknown>,
  "icp_type": <1017=Hospital, 935=Clinic/Polyclinic, 1018=Specialist Practice, 520=Dental Clinic, 932=Diagnostic Center & Laboratory, 939=HIS Software Provider, 937=Nursing Home/Long-term Care, 936=Dialysis Clinic, 1019=Physiotherapy Clinic, 1020=Aesthetic & Plastic Surgery, 1021=Ophthalmology Clinic, 1022=Radiology Center, 1023=Rehabilitation Center, 1024=Mental Health Clinic, 934=Maternity and IVF Clinic, 931=Home Care, 1028=Unknown>,
  "qualify_status": <62=Qualified with contact, 63=Qualified with contact+email, 61=Qualified no contact, 57=To qualify>,
  "org_source": 546,
  "icp_ecosystem": <854=Healthcare ecosystem, 855=Healthcare software vendors, or 0>,
  "his_identification": <850=Yes, 851=No>,
  "company_legal_name": "official legal name with legal form (Ltd, GmbH, UAB, S.A., Sp. z o.o. etc) or empty string",
  "his_software_name": "name of HIS/RIS/LIS/PACS software if they sell or use one, or empty string",
  "ceo_name": "CEO or founder full name if found in website content, or empty string",
  "address": "full street address if found in website content, or empty string",
  "vat": "VAT number if found in website content, or empty string",
  "registration_number": "company registration number if found in website content, or empty string",
  "linkedin_url": "https://linkedin.com/company/... if determinable from company name, or empty string",
  "number_of_beds": 0,
  "number_of_branches": 0,
  "number_of_specialists": 0,
  "company_overview": "2-3 sentence description of what this company does, who they serve, and their key services"
}`
        }]
      })
    });

    const groqData = await groqRes.json();
    const content = groqData.choices?.[0]?.message?.content || '{}';
    const cleanJson = content.replace(/```json\n?|\n?```/g, '').trim();
    enriched = JSON.parse(cleanJson);
  } catch (e) {
    return res.status(500).json({ error: 'AI failed: ' + e.message });
  }

  // ─── Step 3: Build Pipedrive payload ──────────────────────────────────────
  const finalPhone = scraped.phone || '';
  const finalEmail = scraped.email || '';
  const finalLinkedin = scraped.linkedin || enriched.linkedin_url || '';
  const finalAddress = enriched.address || '';

  const payload = {};
  const set = (key, val) => {
    if (val !== undefined && val !== null && val !== '' && val !== 0) payload[key] = val;
  };

  // Standard fields
  if (enriched.industry) payload.industry = enriched.industry;
  if (enriched.annual_revenue) payload.annual_revenue = enriched.annual_revenue;
  if (enriched.employee_count > 0) payload.employee_count = enriched.employee_count;
  if (finalLinkedin) payload.linkedin = finalLinkedin;
  if (finalPhone) payload.phone = [{ value: finalPhone, primary: true, label: 'work' }];
  if (finalAddress) payload.address = { value: finalAddress };

  // Custom fields
  set('0d5afcefbd6ada8781d38fe74873d4b308234a49', enriched.icp);
  set('5b6f71999f89a4ac00ed32f8bd49bc8480bf459d', enriched.ownership);
  set('ef79b1ce2c6860be02443dd9728ad62dd4f8b18c', enriched.icp_type);
  set('18ba6331d70bcfa1eb8cf977c52948c4f2b53df3', enriched.qualify_status);
  set('113a8ed69dfd080a7d1b84392251a3474d989216', enriched.employees_category);
  set('95d37d3df1ed511ae90f7fac64eac37a20f4ed83', enriched.org_source);
  set('e37b931ae0af55393fc51f1b2135c2355b4bea12', enriched.icp_ecosystem);
  set('bb5ec6a8351b0d3423011da1f8dbfd89d8590b27', enriched.his_identification);
  set('0139565cc0f6a8dcc0cae8244b672600adf64860', finalLinkedin);        // Company LinkedIn URL
  set('783923cad610ca666dc3ddac86085a6468c7b809', website || '');         // Website (custom)
  set('99c1cffae1ed208819f80c4c3a1b545d461082bb', finalPhone);            // Phone (custom)
  set('b83bf5f8378a2275b475db4dc64b1101ea48836a', finalEmail);            // Company mail
  set('b4c2b2ef4b92a130ec7de91f4d17622d5640431e', enriched.company_legal_name);
  set('115cfff712c6caf184d7c155838a9dace81e8821', enriched.his_software_name);
  set('4107458f7b06285686f1968fbefa9ea50902cf07', enriched.ceo_name);
  set('6d64ec2abf8d9a01a64c0cbf2f962281845b1c85', finalAddress);
  set('aa9502b251dece8bf94fd779579676f711c7c17d', enriched.vat);
  set('0d6adf6f65d52b61826d207cc40357265b6d6402', enriched.registration_number);
  if (enriched.number_of_beds > 0) payload['03ed00fa62b2687bb7ec4a2b6c3194cc828d81db'] = enriched.number_of_beds;
  if (enriched.number_of_branches > 0) payload['bdc6f4f7031fa45a45aa4cd4cd3014f66f9847cf'] = enriched.number_of_branches;
  if (enriched.number_of_specialists > 0) payload['598c7ea3d04ce28a52985dc15a7f74cb6ff977f3'] = enriched.number_of_specialists;

  // ─── Step 4: Update Pipedrive ────────────────────────────────────────────
  const pdRes = await fetch(
    `https://${PD_DOMAIN}.pipedrive.com/api/v1/organizations/${organizationId}?api_token=${PD_TOKEN}`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
  );
  const pdData = await pdRes.json();
  if (!pdData.success) console.error('Pipedrive error:', JSON.stringify(pdData));

  // Add note
  if (enriched.company_overview) {
    await fetch(`https://${PD_DOMAIN}.pipedrive.com/api/v1/notes?api_token=${PD_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `🤖 AI Enrichment\n\n${enriched.company_overview}`,
        org_id: organizationId
      })
    });
  }

  return res.status(200).json({
    success: true,
    fields_filled: Object.keys(payload).length,
    sources: {
      web_scraping: !!(scraped.email || scraped.phone || scraped.linkedin),
      ai: true
    }
  });
}
