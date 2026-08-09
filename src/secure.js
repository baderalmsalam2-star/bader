// التشفير والمفاتيح — الأرقام المدنية تُخزَّن مشفّرة AES-256-GCM
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KEY_FILE = path.join(__dirname, '..', 'data', 'secret.key');

function getKey() {
  if (!fs.existsSync(KEY_FILE)) {
    fs.writeFileSync(KEY_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  return Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
}

function encrypt(text) {
  if (!text) return null;
  const s = String(text);
  if (s.startsWith('enc:')) return s; // مشفّر سابقاً
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ct = Buffer.concat([cipher.update(s, 'utf8'), cipher.final()]);
  return `enc:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

function decrypt(v) {
  if (!v) return null;
  const s = String(v);
  if (!s.startsWith('enc:')) return s; // بيانات قديمة غير مشفرة
  try {
    const [, iv, tag, ct] = s.split(':');
    const d = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  } catch { return '⚠️ تعذّر فك التشفير'; }
}

// بصمة PIN — تتغير تلقائياً عند تغيير الـ PIN
function pinHash(pin) {
  return crypto.createHash('sha256').update(String(pin) + getKey().toString('hex')).digest('hex');
}

module.exports = { encrypt, decrypt, pinHash };
