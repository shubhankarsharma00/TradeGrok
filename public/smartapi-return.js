const params = new URLSearchParams(location.hash.slice(1));
history.replaceState(null, '', '/auth/smartapi/return');
const input = {};
let valid = true;
for (const name of ['state', 'auth_token', 'feed_token', 'error']) {
  const values = params.getAll(name);
  if (values.length > 1) valid = false;
  if (values.length === 1) input[name] = values[0];
}
for (const name of [...params.keys()]) params.delete(name);
async function complete() {
  if (!valid || !input.state) return location.replace('/?smartapi=error');
  try {
    const response = await fetch('/auth/smartapi/callback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), cache: 'no-store'
    });
    location.replace(response.ok ? '/?smartapi=received' : '/?smartapi=error');
  } catch { location.replace('/?smartapi=error'); }
  finally { for (const name of Object.keys(input)) delete input[name]; }
}
void complete();
