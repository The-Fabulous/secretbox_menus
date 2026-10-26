// Опциональная демонстрационная доставка: тариф, минимум и ориентир времени.
const DeliveryModule = (() => {
  function config(raw) {
    const amount = (value, fallback) => typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? Math.min(1000000, Math.round(value)) : fallback;
    return {
      enabled: raw?.enabled === true,
      fee: amount(raw?.fee, 0),
      minOrder: amount(raw?.min_order, 0),
      freeFrom: typeof raw?.free_from === 'number' && raw.free_from > 0 ? amount(raw.free_from, null) : null,
      travelMinutes: Math.min(240, amount(raw?.travel_minutes, 30)),
    };
  }
  function quote(settings, subtotal, prep) {
    const fee = settings.freeFrom !== null && subtotal >= settings.freeFrom ? 0 : settings.fee;
    return { fee, total: subtotal + fee, minimum: settings.minOrder,
      remaining: Math.max(0, settings.minOrder - subtotal), minutes: prep + settings.travelMinutes };
  }
  function validAddress(value) {
    return typeof value === 'string' && value.trim().length >= 5;
  }
  return { config, quote, validAddress };
})();
