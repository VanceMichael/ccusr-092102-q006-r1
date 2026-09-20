// 地理位置工具：距离计算与按授权精度截断坐标。
// 精度档位：exact 原样保留；street 约百米；district 约公里；none 不保留坐标。

const PRECISION_DECIMALS = {
  exact: 6,
  street: 3,
  district: 2,
};

export const PRECISION_LEVELS = ["exact", "street", "district", "none"];

export function truncateCoords(lat, lng, precision) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (precision === "none") return null;
  const decimals = PRECISION_DECIMALS[precision];
  if (decimals === undefined) return null;
  const factor = 10 ** decimals;
  return {
    lat: Math.round(lat * factor) / factor,
    lng: Math.round(lng * factor) / factor,
    precision,
  };
}

// 公众视图最多给到街道级，即使用户授权了精确坐标。
export function publicCoords(location) {
  if (!location || !location.authorized || location.precision === "none") return null;
  if (location.lat === null || location.lat === undefined) return null;
  const precision = location.precision === "exact" ? "street" : location.precision;
  return truncateCoords(location.lat, location.lng, precision);
}

export function haversineMeters(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

// 区域网格键：约 5 公里网格，用于主管部门按区域统计。
export function gridKey(location) {
  if (!location || location.lat === null || location.lat === undefined) {
    return "未授权位置";
  }
  const cell = 0.05;
  const la = Math.floor(location.lat / cell) * cell;
  const ln = Math.floor(location.lng / cell) * cell;
  return `网格 ${la.toFixed(2)},${ln.toFixed(2)}`;
}
