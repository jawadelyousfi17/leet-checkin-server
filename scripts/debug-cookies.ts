function parseCookies(input: unknown): Record<string, string> | null {
  if (!input || typeof input !== "string" || !input.trim()) return null;
  const out: Record<string, string> = {};
  for (const pair of input.split(/[;\n]/)) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return Object.keys(out).length ? out : null;
}

const sample =
  "key=val;key2=val2; SAPISID=huO00zdYvaH0YcQq/AO_XPOmmfGEMyKZ5u;__Secure-3PAPISID=huO00zdYvaH0YcQq/AO_XPOmmfGEMyKZ5u;AEC=AaJma5vchPt6I8HDTrR4SQB5CbxeuwuRzky7SiVjhmFChGEA6f68gIp53A;NID=531=Q8gEygninVauha-h6TuqYr3WyexQls-5CglqjjE7CDlH6djqntI1DwIPn6Nt-OGJQAlsFpfAaA0IhXMhzk_bKdq84PIA61Rru3enSqI_hpawOZOfLANyc5h1uwjU9nHUnTPpLLJlmTVS4nLcEOMystAdbI07lkU7vQpg-iGuAtdKEmrg3NPha0fsl-ZfMrlLR8vtleLErj4IWc757u6fXEWCpRNyBlL26TX1J8KOZDal0hEV9OLhwJxy5Q92dV5xEhNhp8PU0yFeZmqzidXOeRS9iWSlikWRDBkLNA96BWS3k50tk-3tqS__I_UpbV-ckdzMWL55AhMksqlE4GjxdpZEyMeePdz-0LrS6ucd-m7gQkycF38uUT6Gq7vG0or-mRlSUXUtkfdg0eROZJJ8FxVtBz6zPINFozeDSSxgF6LCH280OygBAvBv98xCy_f7WjJmKpU8US7C2TO9kNMnOCkksRJf8nqZQb-6y50NNB_p3867Oeanlw1lznJZ8xgCQgdGVR4AP5vwMCkWK824zuVISazUM7KQQLO0SIRxj3ttrS7yJYU7ifuVgiUKmelvk24l2rB3uz63LtDXQ43jmZcO3PJ0QnGQfNDck_nt0c9OnJSkqg7DHF6OoCYqV8q3qoXfAcueMmhv0nabZm11JEilQDIKR-EJiYXAjPu4me8PEqV37w2E9Nen7j7xbBq4IlINQ7S1-K3-QgGTiZpgxIIPvX_cEyBMf-vvISW7KBGSt9ekcaosfLythSXxt0cgTiE7hdkTuHH1wm-qKpH125nTrio1CFMb918z1Abi0fj9LkZb2wErkKgQ9A_X05Mvn-s4XgO2awXGDNGbRPSG1iEIRa--kHOL-2G4_LLk5psFnAgktN5D3jMQfYt3KSJy8C0cgzygI8QJ_H-WnWQK8skD4Har5sHi4imAfql_WMozOfaKLsVWWM5a5h3IWNEJINVvO04xwLRtZoJEXRgxL-HHxNf57tLQFGc1h2XuFysMVSyfBb2VFx0anTrKOea1zuiNUAp2G_cjDid1Pn1fZk63xWj8EW8qjn6lhPIreLZJFWjJueUuS_ackQ;__Secure-1PSIDTS=sidts-CjIBhkeRd21mKiG1-KZYmXJL4HtEFPlCov7u1evNL9Pi1IcN_BnAQlngVgWw8p8Wb0gLRxAA;__Secure-1PAPISID=huO00zdYvaH0YcQq/AO_XPOmmfGEMyKZ5u;__Secure-3PSID=g.a0009AhJz1IXmlktjTZ5jodqADvFwRp9JiqUQ0iNj62nXh9-kuIK_eJdapEY4-p6B5fYiW_QiwACgYKAfwSARcSFQHGX2MiYAm1ITbSDuHw6vi5dPNdtBoVAUF8yKqheYAftHL8KQN-Ey_28_9R0076;__Secure-1PSID=g.a0009AhJz1IXmlktjTZ5jodqADvFwRp9JiqUQ0iNj62nXh9-kuIKlq-SJQ3LtRHXn66oI4Sl5AACgYKAdUSARcSFQHGX2MipwYGmv7Dt1qUaFTAoxLNhRoVAUF8yKr5ApZWtU8gGm7Ie9KQ_b1d0076;SSID=ArBSANdbHXR5cEInE";

const out = parseCookies(sample);
console.log("parsed", Object.keys(out ?? {}).length, "cookies");
for (const [k, v] of Object.entries(out ?? {})) {
  const preview = v.length > 50 ? v.slice(0, 47) + "..." : v;
  console.log(`  ${k} = ${preview}`);
}
