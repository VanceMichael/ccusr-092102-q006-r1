// 隐私边界：所有对外响应必须经过这里的序列化器。
// 举报人联系方式（contact）与查询令牌（reporter_token）存储在库内，
// 不出现在任何 API 响应中——包括内部角色，避免进度公开时泄露。

import { publicCoords } from "./geo.js";

export function publicPhoto(photo) {
  return {
    id: photo.id,
    url: `/api/photos/${photo.id}`,
    fingerprint: photo.fingerprint,
    masks_applied: photo.masks.length,
    created_at: photo.created_at,
  };
}

export function publicVersion(version, photos) {
  return {
    id: version.id,
    seq: version.seq,
    source: version.source,
    note: version.note ?? null,
    photos: photos.filter((p) => version.photos.includes(p.id)).map(publicPhoto),
    created_at: version.created_at,
  };
}

// 公众可见的标识详情：设置单位、语种、规范条款、状态、规范译法、
// 按授权截断后的位置与各现场版本；不含任何举报人信息。
export function publicSign(sign, versions, photos) {
  return {
    id: sign.id,
    setting_unit: sign.setting_unit,
    languages: sign.languages,
    norm_clauses: sign.norm_clauses,
    status: sign.status,
    standard_translation: sign.standard_translation ?? null,
    location: publicCoords(sign.location),
    address_text: sign.location?.authorized ? sign.address_text ?? null : null,
    versions: versions
      .filter((v) => v.sign_id === sign.id)
      .sort((a, b) => a.seq - b.seq)
      .map((v) => publicVersion(v, photos)),
    created_at: sign.created_at,
    closed_at: sign.closed_at ?? null,
  };
}

export function publicSignSummary(sign) {
  return {
    id: sign.id,
    setting_unit: sign.setting_unit,
    languages: sign.languages,
    status: sign.status,
    standard_translation: sign.standard_translation ?? null,
    location: publicCoords(sign.location),
    created_at: sign.created_at,
  };
}

// 举报人凭一次性令牌查询自己线索的进度：只看状态流转与最终规范译法。
export function progressView(report, sign, versions) {
  return {
    report_id: report.id,
    status: report.status,
    submitted_at: report.created_at,
    sign: sign
      ? {
          id: sign.id,
          status: sign.status,
          setting_unit: sign.setting_unit,
          standard_translation: sign.standard_translation ?? null,
          site_versions: versions.filter((v) => v.sign_id === sign.id).length,
        }
      : null,
  };
}
