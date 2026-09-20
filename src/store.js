// 极简 JSON 文件存储：写临时文件后原子替换，避免半截写入。
// 数据集合：users / signs / versions / photos / reports / proposals /
// reviews / rectifications / merge_candidates。

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const EMPTY = {
  users: [],
  signs: [],
  versions: [],
  photos: [],
  reports: [],
  proposals: [],
  reviews: [],
  rectifications: [],
  merge_candidates: [],
};

export class Store {
  constructor(file) {
    this.file = file;
    this.data = structuredClone(EMPTY);
  }

  load() {
    if (existsSync(this.file)) {
      this.data = { ...structuredClone(EMPTY), ...JSON.parse(readFileSync(this.file, "utf8")) };
    }
    return this;
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = join(dirname(this.file), `.${Date.now()}.tmp`);
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }

  id(prefix) {
    return `${prefix}_${randomUUID().slice(0, 8)}`;
  }

  find(collection, id) {
    return this.data[collection].find((row) => row.id === id) ?? null;
  }
}
