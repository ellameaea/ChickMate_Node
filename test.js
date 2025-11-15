// helper: produce an ISO-like timestamp in Asia/Manila with +08:00 offset
function getManilaISO(date = new Date()) {
  // use Intl to get zero-padded components in Manila timezone
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Manila',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).formatToParts(date);

  const map = {};
  parts.forEach(p => { if (p.type !== 'literal') map[p.type] = p.value; });

  // compose ISO-like string with +08:00 offset
  return `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}:${map.second}+08:00`;
}

console.log(new Date().toISOString());         // UTC
console.log(getManilaISO(new Date()));         // Asia/Manila +08:00