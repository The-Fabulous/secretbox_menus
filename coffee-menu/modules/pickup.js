// Опциональный самовывоз. Чистая логика; отправки заказа и оплаты нет.
const PickupModule = (() => {
  function config(raw) {
    const value = Number(raw?.ready_minutes);
    return {
      enabled: raw?.enabled === true,
      readyMinutes: Number.isFinite(value) && value > 0 ? Math.min(240, Math.round(value)) : 20,
      address: typeof raw?.address === 'string' ? raw.address.trim() : '',
    };
  }
  function quote(settings, subtotal, prep) {
    return { fee: 0, total: subtotal, minimum: 0, remaining: 0, minutes: Math.max(prep, settings.readyMinutes) };
  }
  return { config, quote };
})();
