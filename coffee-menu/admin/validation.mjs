export const LIMITS = { files: 24, fileBytes: 8 * 1024 * 1024, totalBytes: 20 * 1024 * 1024 };
export const IMAGE = /\.(jpe?g|png|webp|bmp)$/i;
export const VALID_ID = /^[a-z][a-z0-9_]{0,63}$/;

export function inspectPackage(id, files, config) {
  if (!VALID_ID.test(id)) throw new Error('Имя папки: строчные латинские буквы, цифры и _, начало — буква. До 64 символов.');
  if (!Array.isArray(files) || files.length < 2 || files.length > LIMITS.files)
    throw new Error(`Нужны cafe.json и скрины меню. Не более ${LIMITS.files} файлов.`);
  const names = new Set();
  let total = 0;
  for (const file of files) {
    if (typeof file.name !== 'string' || file.name.length > 160 || /[/\\\x00-\x1f:*?"<>|]/.test(file.name)
        || file.name.startsWith('.') || /[. ]$/.test(file.name)) throw new Error('Файлы должны лежать прямо в папке заведения, без вложенных папок.');
    if (file.name !== 'cafe.json' && !IMAGE.test(file.name)) throw new Error(`Неподдерживаемый файл: ${file.name}`);
    if (names.has(file.name.toLowerCase())) throw new Error(`Повторяющееся имя файла: ${file.name}`);
    names.add(file.name.toLowerCase());
    if (!Number.isInteger(file.size) || file.size <= 0 || file.size > LIMITS.fileBytes)
      throw new Error(`Файл ${file.name}: допустимый размер от 1 байта до 8 МБ.`);
    total += file.size;
  }
  if (total > LIMITS.totalBytes) throw new Error('Вся папка должна быть не больше 20 МБ.');
  if (!files.some(f => f.name === 'cafe.json')) throw new Error('В папке отсутствует cafe.json.');
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('cafe.json должен содержать объект JSON.');
  if (typeof config.name !== 'string' || !config.name.trim() || config.name.length > 160)
    throw new Error('В cafe.json укажите название заведения в поле name (до 160 символов).');
  for (const key of ['address', 'city', 'hours']) {
    if (config[key] != null && (typeof config[key] !== 'string' || config[key].length > 300))
      throw new Error(`Поле ${key} должно быть текстом до 300 символов или null.`);
  }
  if (config.logo != null && (typeof config.logo !== 'string' || !IMAGE.test(config.logo)
      || !files.some(f => f.name === config.logo))) throw new Error('logo должен указывать на изображение внутри этой же папки либо быть null.');
  const images = files.filter(f => IMAGE.test(f.name) && f.name !== config.logo);
  if (!images.length) throw new Error('Добавьте хотя бы один скрин меню, помимо логотипа.');
  if (config.modules != null) {
    if (typeof config.modules !== 'object' || Array.isArray(config.modules)) throw new Error('modules должен быть объектом.');
    for (const key of ['pickup', 'delivery']) {
      const mod = config.modules[key];
      if (mod == null) continue;
      if (typeof mod !== 'object' || Array.isArray(mod) || typeof mod.enabled !== 'boolean')
        throw new Error(`modules.${key}.enabled должен быть true или false.`);
      for (const field of ['fee', 'min_order', 'free_from', 'travel_minutes', 'ready_minutes']) {
        if (mod[field] != null && (typeof mod[field] !== 'number' || !Number.isFinite(mod[field]) || mod[field] < 0))
          throw new Error(`${key}.${field} должен быть неотрицательным числом.`);
      }
      if (mod.address != null && (typeof mod.address !== 'string' || mod.address.length > 300))
        throw new Error('Адрес самовывоза должен быть текстом до 300 символов.');
    }
  }
  return { id, name: config.name.trim(), imageCount: images.length, bytes: total,
    pickup: config.modules?.pickup?.enabled === true, delivery: config.modules?.delivery?.enabled === true };
}
