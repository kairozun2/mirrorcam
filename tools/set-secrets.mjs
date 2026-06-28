import _sodium from 'libsodium-wrappers';
import { readFileSync } from 'node:fs';

const TOKEN = process.env.GH_TOKEN;
const OWNER = 'kairozun2';
const REPO = 'mirrorcam';

const privateKey = readFileSync('C:/Users/User/tauri-keygen/mirrorcam.key', 'utf8');
const password = 'Mirr0rCam_Upd8_Key_2026';

const secrets = {
  TAURI_SIGNING_PRIVATE_KEY: privateKey,
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password,
};

const headers = {
  Authorization: `token ${TOKEN}`,
  'User-Agent': 'MirrorCam',
  Accept: 'application/vnd.github+json',
};

async function main() {
  await _sodium.ready;
  const sodium = _sodium;

  const pkRes = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/actions/secrets/public-key`,
    { headers }
  );
  if (!pkRes.ok) throw new Error('public-key: ' + pkRes.status + ' ' + (await pkRes.text()));
  const { key, key_id } = await pkRes.json();

  for (const [name, value] of Object.entries(secrets)) {
    const binKey = sodium.from_base64(key, sodium.base64_variants.ORIGINAL);
    const binSec = sodium.from_string(value);
    const enc = sodium.crypto_box_seal(binSec, binKey);
    const encrypted_value = sodium.to_base64(enc, sodium.base64_variants.ORIGINAL);

    const res = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/actions/secrets/${name}`,
      {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ encrypted_value, key_id }),
      }
    );
    console.log(`${name}: ${res.status}`);
    if (!res.ok) console.log(await res.text());
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
