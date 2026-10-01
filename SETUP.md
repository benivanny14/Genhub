# GENHUB — Kuweka kila kitu, hatua kwa hatua

Mwongozo huu unakuelekeza **wapi** unaweka kila kitu na **wapi** unakipata.
Fuata kwa mpangilio. Kila hatua inaonyesha jina kamili la variable, mahali
unapopata thamani, na jinsi ya kuthibitisha kwamba inafanya kazi.

**Wakati unaohitajika:** ~2 saa kwa yote. Hatua 1 na 2 ni dakika 7 pekee na
ndiyo za lazima zaidi kisheria.

---

## Utangulizi: faili MOJA tu unaloandika

Kila kitu kinaenda kwenye faili **kimoja**: `.env.local`, kwenye mzizi wa
project (kando ya `package.json`).

### Anza na amri MOJA

```bash
npm run setup
```

Inafanya vitu vinne kwa niaba yako:

1. Inaunda `.env.local` kutoka template kama haipo.
2. **Inazalisha siri tatu** (`JWT_SECRET`, `CRON_SECRET`,
   `CLICKPESA_WEBHOOK_TOKEN`) — hivi ndivyo vinavyochanganya zaidi, na sasa
   huhitaji kuzalisha mwenyewe. Hatuonyeshi hapa; ziko kwenye faili pekee.
3. **Haitogusi** value iliyopo tayari na nzuri. Hii ni muhimu: kubadilisha
   `CRON_SECRET` kunavunja scheduler, na kubadilisha
   `CLICKPESA_WEBHOOK_TOKEN` kunavunja webhook iliyosajiliwa. Inatumia kanuni
   ile ile ya `assessSecret` ambayo `preflight` na `verify:live` zinatumia,
   kwa hivyo script tatu haziwezi kutofautiana.
4. Inafungua faili kwenye Notepad, na inakuonyesha **kila kitu kilichobaki**
   pamoja na website ya kukipata na hatua za kubofya.

Kama unataka kuifungua mwenyewe baadaye: `notepad .env.local`.

Endesha `npm run setup` **mara kwa mara** — kila unapomaliza hatua moja,
inaonyesha kilichobaki, kinachopungua.

### Kanuni nne za faili hili (zikikiukwa, thamani inavunjika)

1. **`JINA=thamani`** — hakuna nafasi karibu na `=`.
   `JWT_SECRET = abc` ni **kosa**; `JWT_SECRET=abc` ni sahihi.
2. **Comments ni `#`** — unaweza kuandika maelezo kwenye mstari huo huo, na
   ukifanya hivyo kwa thamani isiyo na quotes, comment inatupwa. Kwa hivyo
   `.env.example` inaweza kunakiliwa kama ilivyo.
3. **URL hazina `/` ya mwisho.** `https://www.genhub-two.site` ✅ ·
   `https://www.genhub-two.site/` ✗ (inavunja webhook na links).
4. **Ukibadilisha faili hili, restart server.** Next.js inasoma `.env.local`
   mara moja tu inapoanza: `Ctrl+C` kisha `npm run dev`.

**`verify:live` ni rafiki yako.** Baada ya *kila* hatua, endesha:

```bash
npm run verify:live
```

Inaunganisha kwa kila huduma kwa kweli na kukuambia kilichovunjika na kwa nini —
kabla ya mteja kupiga simu.

---

## Hatua 1 — Siri tatu (dakika 2, hakuna akaunti)

Hizi **wezi** kuzipata kwa mtu — unazizalisha mwenyewe. Usizitume kwa mtu
yeyote, na usizibandike kwenye chat au email.

Endesha kwenye terminal:

```bash
openssl rand -hex 32
```

Kama `openssl` haipo (Windows), tumia hii:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Endesha **mara tatu** (kila moja inatoa thamani tofauti) na uweke moja kwa kila
variable:

| Variable | Inalinda nini | Ukibadilisha |
|---|---|---|
| `JWT_SECRET` | Vipindi vya watumiaji (login) | Kila mtu anatolewa — wote wanaingia tena |
| `CRON_SECRET` | Cron jobs zinazolipa waundaji | Lazima uibadilishe kwenye scheduler pia |
| `CLICKPESA_WEBHOOK_TOKEN` | Kwamba webhook ya malipo ni yetu | Lazima ilingane na ile iliyopo kwenye URL ya webhook (au tumia `CLICKPESA_CHECKSUM_KEY`) |

> ⚠️ **Muhimu:** `.env.local` yako ya sasa ina `JWT_SECRET=dev-freebuff-...`,
> ambayo ni **placeholder** — neno la kibinadamu linaloweza kukisiwa, na
> limeandikwa kwenye historia ya project hii. Kwa local dev ni sawa. **Usiikwae
> kwenye production**: mtu yeyote anayeikisia anaweza kubuni kipindi cha ADMIN.
> Ndiyo maana `preflight:prod` sasa inakataa thamani hii, na `auth.ts` inakataa
> kusaini tokeni kwa production ikiwa bado ipo.

---

## Hatua 2 — Taarifa za kisheria (dakika 5, hakuna akaunti)

Hii ni **lazima kwa sheria**, si mapambo. Unauza content ya watu wazima, na
18 U.S.C. §2257 / 28 C.F.R. §75.2 inahitaji ukurasa wa `/2257` umtaje mtu
anayehifadhi kumbukumbu za uthibitisho wa umri, pamoja na **mahali halisi**
anapofanya kazi.

| Variable | Unapata wapi |
|---|---|
| `NEXT_PUBLIC_COMPANY_LEGAL_NAME` | Jina la kampuni kwenye cheti cha BRELA (au jina lako kama mtu binafsi) |
| `NEXT_PUBLIC_COMPANY_ADDRESS` | Anwani halisi ya ofisi. **Sio** P.O. Box pekee — inahitajika anwani ya mahali |
| `NEXT_PUBLIC_SUPPORT_EMAIL` | Barua pepe unayotaka DMCA/compliance zifike (inaweza kuwa Gmail) |

Mfano:

```env
NEXT_PUBLIC_COMPANY_LEGAL_NAME=Genhub Media Ltd
NEXT_PUBLIC_COMPANY_ADDRESS=Plot 42, Nyerere Road, Dar es Salaam, Tanzania
NEXT_PUBLIC_SUPPORT_EMAIL=compliance@genhub-two.site
```

Thibitisha: `npm run verify:live` → `✓ 2257 records`.

---

## Hatua 3 — Postgres ya managed (dakika 15) · Neon

Kwa nini: database yako sasa iko kwenye kompyuta yako. Ikifa, biashara inaisha.

1. Nenda **https://neon.tech** → *Sign up* (tumia GitHub, haraka zaidi).
2. **Create project**:
   - Name: `genhub`
   - Postgres version: default
   - Region: chagua iliyo karibu na watumiaji wako (kwa Tanzania: `AWS eu-central-1`
     ikiwa `af-south-1` haipo)
3. Baada ya project kufunguka, tafuta kitufe cha **Connection string** →
4. **Washa toggle ya "Pooled connection"** ← hii ni muhimu.
5. Nakili string. Inaonekana hivi:

```
postgresql://genhub_owner:AbC123@ep-cool-name-123456-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require
```

6. Weka kama `DATABASE_URL=...`

> **Kwa nini "Pooled"?** Kwenye Vercel kila instance ya function inafungua
> connection yake. Connection ya moja kwa moja ina limit ndogo, na website
> inakwama chini ya mzigo. Hostname ya pooled ina **`-pooler`** ndani yake —
> `verify:live` inakuonya kama hujaichagua.

Kisha hamisha schema yako:

```bash
npm run db:deploy     # prisma migrate deploy
npm run db:status     # inatakiwa: Database schema is up to date!
```

> Kumbuka: `db push` haitoi historia ya migrations. Production inatumia
> `db:deploy` pekee.

---

## Hatua 4 — Redis ya managed (dakika 10) · Upstash

Kwa nini: bila hii, rate limiting inakuwa ya kila instance (kwenye Vercel
instances ni nyingi, kwa hivyo limit inapotea), na cache inareset kila deploy.

1. Nenda **https://upstash.com** → *Sign up*.
2. **Create Database**:
   - Name: `genhub`
   - Type: **Regional**
   - Region: ile ya karibu
   - TLS: **enable** (default)
3. Kwenye ukurasa wa database → tab **Connect**. Upstash inatoa **jozi MBILI** —
   **yoyote inafanya kazi**. Chagua **moja**:

**Njia A — REST (inapendekezwa).** Chagua **REST API** → nakili vitu **viwili**:

```
UPSTASH_REDIS_REST_URL=https://healthy-panda-12345.upstash.io
UPSTASH_REDIS_REST_TOKEN=AXxxQwErTy123...
```

Ni muunganisho wa **HTTPS**, kwa hivyo haushikilii TCP pool kati ya maombi —
fits serverless (Vercel) vizuri zaidi.

**Njia B — TCP.** Chagua **Node** / **ioredis** → nakili URL **moja**
inayoanza na **`rediss://`** (herufi **mbili** za `s` = TLS):

```
REDIS_URL=rediss://default:AXxxQwErTy123@healthy-panda-12345.upstash.io:6379
```

4. Weka kwenye `.env.local`. Ukiweka zote mbili, **REST inashinda**.

> ⚠️ Kama unatumia `redis://` (moja `s`), trafiki haijasimbwa na
> `verify:live` itakuonya.

> ⚠️ **Vitu viwili vya REST vinahitajika wote.** URL pekee haifanyi kazi —
> ukiacha token, Setup tab inakuambia.

---

## Hatua 5 — Bunny.net: video (dakika 30)

Hii inafungua **upload ya waundaji** na **streaming halisi**. Bila hii website
inafanya kazi kwa video za demo pekee.

### 5a. Library ya Stream

1. **https://bunny.net** → *Sign up* → thibitisha barua pepe.
2. Menu ya kushoto → **Stream** → **Add Library**:
   - Name: `genhub`
   - Region: ile ya karibu
3. Ingia kwenye library → tab **API**. Utapata vitu viwili:
   - **Library ID** (namba) → `BUNNY_STREAM_LIBRARY_ID=123456`
   - **API Key** (inaanza `a1b2...`) → `BUNNY_STREAM_API_KEY=...`

### 5b. Washa Token Authentication — **hii ni ya lazima**

Bila hii, tokeni iliyosainiwa inapuuzwa: mtu yeyote anayenakili link ya video
anaweza kuitazama bila kulipa.

4. Kwenye library ile ile → tab **Security** → **Token Authentication** →
   **Enable**.
5. Nakili **Token Authentication Key** → `BUNNY_TOKEN_SECRET=...`

### 5c. CDN hostname

6. Kwenye library → tab **API** → tafuta **CDN Hostname**. Inaonekana kama:

```
vz-a1b2c3d4-567.b-cdn.net
```

7. `BUNNY_CDN_HOSTNAME=vz-a1b2c3d4-567.b-cdn.net` (bila `https://`)

### 5d. Storage zone (thumbnails na picha)

8. Menu ya kushoto → **Storage** → **Add Storage Zone** → Name: `genhub-thumbs`
   (Region ile ile).
9. Kwenye zone → tab **FTP & API Access** → kwenye **Password**, bofya
   *Copy*/*Show* → hiyo ni `BUNNY_STORAGE_ACCESS_KEY=...`
10. `BUNNY_STORAGE_ZONE=genhub-thumbs` (jina kamili, kama lilivyo)

Thibitisha: `npm run smoke:bunny` kisha `npm run verify:live` →

```
✓ Bunny Stream   OK   library "genhub" · Token Auth ON
✓ Bunny CDN      OK   vz-....b-cdn.net answered HTTP 200
```

> `verify:live` inakuonya kwa sauti kama **Token Auth ipo OFF** — hilo ni
> shimo la usalama, sio kelele ya kawaida.

---

## Hatua 6 — SMTP: barua pepe (dakika 15) · Resend

Kwa nini: bila hii **watumiaji hawawezi kurejesha password**. Barua zinaenda
kwenye log tu, na mtu aliyesahau password yake amepotea milele.

1. **https://resend.com** → *Sign up*.
2. **Domains** → **Add Domain** → weka domain yako (k.m. `genhub-two.site`).
3. Resend itatoa rekodi za DNS (SPF/DKIM). Ziweke kwenye registrar yako.
   Subiri hadi status iwe **Verified** (dakika chache hadi saa).
4. **API Keys** → **Create API Key** (permission: *Sending access*) → nakili
   (inaanza `re_...`). **Utaiona mara moja pekee.**
5. Weka hivi:

```env
SMTP_HOST=smtp.resend.com
SMTP_PORT=465
SMTP_USER=resend
SMTP_PASS=re_XXXXXXXXXXXX
EMAIL_FROM=Genhub <no-reply@genhub-two.site>
```

**Mambo ya kuepuka:**
- `SMTP_USER` ni **`resend`** (neno hilo hasa) — sio barua pepe yako.
- `EMAIL_FROM` **lazima** iwe kwenye domain uliyothibitisha, la sivyo barua
  zinakataliwa au zinaenda spam.
- Port 465 inatumia SSL; port 587 inatumia STARTTLS. Ikiwa 465 haifanyi kazi,
  jaribu 587.

### SMS (HAITUMIKI — si lazima) — Africa's Talking

**Hakuna feature yoyote inayotuma SMS sasa.** Kurejesha password kunatumwa kwa
**email pekee**, na usajili unahitaji barua pepe — kwa hivyo akaunti yenye namba
ya simu pekee haijafanywa tena. Akaunti za zamani za aina hiyo zinaweza kuingia
kwa namba yao, na admin anaweza kuwatumia reset link (Admin → Users → *Reset
link*).

Sehemu hii imebaki kwa sababu `src/lib/sms.ts` ipo kwa matumizi ya baadaye (k.m.
kuthibitisha malipo yaliyolipwa) — si kwa ajili ya kurejesha password. Usiweke
`AT_API_KEY` kwa matumaini kwamba inasaidia reset: haifanyi hivyo.

Hatua hizi zinafanya kazi ikiwa utaihitaji siku moja:

1. **https://africastalking.com** → *Sign up* → **Go to Sandbox** kwa majaribio.
2. **Settings** → **API Key** → nakili → `AT_API_KEY=...`
3. Username yako → `AT_USERNAME=...` (kwenye sandbox ni `sandbox`)

---

## Hatua 7 — ClickPesa (dakika 15, inahitaji akaunti)

ClickPesa ndiyo gateway pekee. **ClickPesa haina float**: kila collection
inaingia moja kwa moja kwenye akaunti yako ya merchant, kwa hivyo
hakuna salio la kuweka. Kinachohitajika ni vitambulisho vitatu, vyote kutoka
*Settings → Developers* kwenye dashboard yako ya ClickPesa:

| Variable | Inalinda nini |
|---|---|
| `CLICKPESA_CLIENT_ID` | Kutambulisha akaunti yako kwa ClickPesa |
| `CLICKPESA_API_KEY` | Siri ya kuzalisha token |
| `CLICKPESA_CHECKSUM_KEY` | Kuhakikisha kila callback ni ya ClickPesa (hiari lakini inashauriwa) |

1. **Weka vitambulisho.** Nakili `CLIENT_ID` na `API_KEY` kwenye `.env.local`.
   `CLICKPESA_BASE_URL` si lazima — default ni
   `https://api.clickpesa.com/third-parties`.

2. **Sajili webhook.** Kwenye dashboard: *Settings → Developers → application
   yako → Application Webhooks*. Weka URL:

   `https://<domain yako>/api/webhooks/clickpesa`

   Kwa usalama wa ziada weka `CLICKPESA_CHECKSUM_KEY` ili kila callback
   ithibitishwe kwa HMAC-SHA256. Bila key hiyo, mfumo unatumia token
   (`CLICKPESA_WEBHOOK_TOKEN`, unaozalishwa na `npm run setup`) — na token hiyo
   inatakiwa iwe kwenye URL iliyosajiliwa.

3. **Thibitisha kwa simu yako mwenyewe:**

```bash
npm run smoke:clickpesa -- --collect 1000 0XXXXXXXXX
```

Ingiza PIN. Kisha `npm run verify:live` inatakiwa kuonyesha
`✓ ClickPesa  token minted`.

> **ClickPesa haina sandbox** — kila ombi ni la live. Kabla ya KYC, kikomo ni
> TZS 100,000 kwa jumla na miito 100 kwa siku (pamoja na kutengeneza token).
>
> Mfumo **haukuruhusu** mteja kulipa mara mbili kwa bahati mbaya: charge inayobaki
> `processing` baada ya saa 1 inaingia hali `UNDER_INVESTIGATION` na mteja
> anaona *"We are checking with the network — please do not pay again"* — si
> "jaribu tena". Admin anaona kila kesi kwenye **Admin → Payments → Being checked**.

---

## Hatua 8 — Domain na Vercel (dakika 30)

### 8a. Domain

Nunua domain kwa **Namecheap**, **Cloudflare** (nafuu), au **Truehost** (Tanzania).
Kwa content ya watu wazima, chagua registrar inayoruhusu — Cloudflare na Namecheap
wanaruhusu.

### 8b. Deploy kwenye Vercel

1. **https://vercel.com** → *Sign up* → fanya kitu cha kwanza: **Add New →
   Project** → **Import Git Repository**.
2. Framework preset itagundua **Next.js** yenyewe. **Usibadilishe build command.**
3. Fungua **Environment Variables**. Kwa **kila** variable kwenye `.env.local`
   yako, weka jina lile lile na thamani ile ile. Ongeza hizi:
   - `NEXT_PUBLIC_APP_URL=https://www.genhub-two.site` (domain halisi, bila `/` mwishoni)
   - `NODE_ENV=production`
4. Bofya **Deploy**.
5. Baada ya deploy → **Settings → Domains** → ongeza `genhub-two.site` na
   `www.genhub-two.site` → Vercel itakuambia rekodi za DNS. Ziweke kwenye registrar.
6. Vercel inatoa TLS **kiotomatiki** — hakuna unachofanya.

### 8c. Ushindi wa mwisho: admin wako mwenyewe

Demo login **imezuiwa** kwenye production (kwa msimbo). Hivyo huwezi kuingia
admin bila kuunda akaunti yako halisi.

Kama barua pepe yako **haipo** bado kwenye DB (kesi ya kawaida kwenye DB mpya),
tumia `--create` — script inaunda akaunti na **password ya muda inachapishwa mara
moja pekee**. Nakili na uibadilishe mara moja unapoingia:

```bash
npm run admin:create -- wewe@domain.com --create
```

Kama umejisajili tayari kwenye website (kama VIEWER), tumia hii badala yake —
inapandisha cheo bila kubadilisha password yako:

```bash
npm run admin:create -- wewe@domain.com
```

> `npm run` inahitaji `--` kabla ya arguments, la sivyo npm inazimeza.

Baada ya kupandishwa cheo **toka kisha ingia tena**: role inaishi ndani ya JWT,
kwa hivyo cookie ya zamani bado inasema VIEWER.

> Script hii lazima iendeshwe ikiwa na `DATABASE_URL` ya **production** kwenye
> mazingira — ndiyo DB inayoandikwa. Kwenye kompyuta yako, weka connection
> string ya production kwa amri hiyo pekee.

---

## Hatua 9 — Uthibitisho wa mwisho

```bash
npm run verify:live            # kila connection halisi: ✓ au ✗ na sababu
npm run preflight:prod         # orodha ya blockers zote
npm run verify:env -- --strict # BLOCKING
npm run db:deploy              # migrations kwenye DB ya production
npm run build                  # guard: build inakataa ikiwa config haijakamilika
```

Njia ya haraka zaidi ya kujua nini kimebaki:

```bash
npm run preflight:prod
```

---

## Jedwali la muhtasari — kila variable na inapotoka

| Variable | Inatoka wapi | Ya lazima? |
|---|---|---|
| `NEXT_PUBLIC_APP_URL` | Domain yako + Vercel | ✅ **Ndiyo** |
| `NEXT_PUBLIC_COMPANY_LEGAL_NAME` | Cheti cha BRELA | ✅ **Ndiyo (sheria)** |
| `NEXT_PUBLIC_COMPANY_ADDRESS` | Anwani halisi ya ofisi | ✅ **Ndiyo (sheria)** |
| `NEXT_PUBLIC_SUPPORT_EMAIL` | Barua pepe yako | ✅ Ndiyo |
| `DATABASE_URL` | Neon (pooled) | ✅ **Ndiyo** |
| `JWT_SECRET` | `openssl rand -hex 32` | ✅ **Ndiyo** |
| `CRON_SECRET` | `openssl rand -hex 32` | ✅ Ndiyo |
| `CLICKPESA_CLIENT_ID` | ClickPesa → Settings → Developers | ✅ Ndiyo |
| `CLICKPESA_API_KEY` | ClickPesa → Settings → Developers | ✅ Ndiyo |
| `CLICKPESA_CHECKSUM_KEY` | ClickPesa → Settings → Developers | ✅ Ndiyo |
| `PAYMENT_SANDBOX` | `false` kwa malipo halisi | ✅ Ndiyo |
| `BUNNY_STREAM_API_KEY` | Bunny → Stream → API | ⬜ Kwa upload |
| `BUNNY_STREAM_LIBRARY_ID` | Bunny → Stream → API | ⬜ Kwa upload |
| `BUNNY_TOKEN_SECRET` | Bunny → Stream → Security | ⬜ Kwa upload |
| `BUNNY_CDN_HOSTNAME` | Bunny → Stream → API | ⬜ Kwa playback |
| `BUNNY_STORAGE_ZONE` | Bunny → Storage | ⬜ Kwa thumbnails |
| `BUNNY_STORAGE_ACCESS_KEY` | Bunny → Storage → FTP & API | ⬜ Kwa thumbnails |
| `SMTP_HOST/PORT/USER/PASS` | Resend | ⬜ Lakini password reset inavunjika |
| `EMAIL_FROM` | Domain yako | ⬜ Lakini barua zinaenda spam |
| `UPSTASH_REDIS_REST_URL` + `..._TOKEN` | Upstash → REST API | ⬜ Lakini rate limiting inadhoofika |
| `REDIS_URL` (njia mbadala) | Upstash → ioredis | ⬜ Kama huna jozi ya REST |
| `AT_API_KEY` / `AT_USERNAME` | Africa's Talking | ⬜ Kwa users wa simu pekee |

---

## Kile ambacho **hakuna** cha kufanya

Kuna features za OnlyFans/Brazzers ambazo **hazipo**, lakini hizi **si bugs** —
ni features za baadaye. Website inafanya kazi kamili bila zote:

tiered subscriptions (3/6-month discount, free trial) · PPV mass DM ·
block/mute/restrict · 2FA · scheduled posts · geo-blocking · creator vault ·
stories · media bundles.

Amua baadaye ikiwa unazitaka kulingana na mahitaji ya biashara.
