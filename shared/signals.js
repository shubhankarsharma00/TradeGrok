export const money = number => Math.round((number + Number.EPSILON) * 100) / 100;
export const average = values => values.reduce((a, b) => a + b, 0) / values.length;

export function signal(bot, price) {
  if (bot.preset === 'dip') return price <= bot.level;
  if (bot.preset === 'breakout' || bot.preset === 'swing') return bot.previous !== null && bot.previous <= bot.level && price > bot.level;
  if (bot.samples.length < 13) return false;
  const prev = bot.samples.slice(0, -1);
  return average(prev.slice(-5)) <= average(prev.slice(-12)) && average(bot.samples.slice(-5)) > average(bot.samples.slice(-12));
}

export function exitSignal(bot, price) {
  if (bot.exitPreset === 'support') return price <= bot.exitLevel;
  if (bot.exitPreset === 'sma' && (bot.exitSamples ?? []).length >= 12) return average(bot.exitSamples.slice(-5)) < average(bot.exitSamples.slice(-12));
  return false;
}
