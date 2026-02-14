function ts(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

function mapRow(row) {
  if (!row) {
    return null;
  }
  return {
    tenantId: row.tenant_id,
    actorId: row.agent_id,
    displayName: row.display_name,
    avatarUrl: row.avatar_url || null,
    bio: row.bio || null,
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    theme:
      row.metadata &&
      typeof row.metadata === "object" &&
      row.metadata.theme &&
      typeof row.metadata.theme === "object"
        ? row.metadata.theme
        : null,
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at)
  };
}

export class PgProfileStore {
  constructor({ pool } = {}) {
    this.pool = pool;
  }

  async init() {
    return true;
  }

  async get({ tenantId, actorId }) {
    const result = await this.pool.query(
      `
      SELECT tenant_id, agent_id, display_name, avatar_url, bio, metadata, created_at, updated_at
      FROM agents
      WHERE tenant_id = $1 AND agent_id = $2
      LIMIT 1
      `,
      [tenantId, actorId]
    );
    return mapRow(result.rows[0]);
  }

  async upsert({ tenantId, actorId, displayName, avatarUrl = null, bio = null, theme = null, metadata = {} }) {
    const safeMetadata = metadata && typeof metadata === "object" ? { ...metadata } : {};
    if (theme && typeof theme === "object") {
      safeMetadata.theme = theme;
    } else {
      delete safeMetadata.theme;
    }
    const result = await this.pool.query(
      `
      INSERT INTO agents (
        tenant_id, agent_id, display_name, avatar_url, bio, metadata, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6::jsonb, now(), now()
      )
      ON CONFLICT (tenant_id, agent_id)
      DO UPDATE SET
        display_name = EXCLUDED.display_name,
        avatar_url = EXCLUDED.avatar_url,
        bio = EXCLUDED.bio,
        metadata = EXCLUDED.metadata,
        updated_at = now()
      RETURNING tenant_id, agent_id, display_name, avatar_url, bio, metadata, created_at, updated_at
      `,
      [
        tenantId,
        actorId,
        String(displayName || "").trim(),
        avatarUrl == null || avatarUrl === "" ? null : String(avatarUrl),
        bio == null || bio === "" ? null : String(bio),
        JSON.stringify(safeMetadata)
      ]
    );
    return mapRow(result.rows[0]);
  }

  async patch({ tenantId, actorId, patch }) {
    const existing = await this.get({ tenantId, actorId });
    if (!existing) {
      return null;
    }
    const next = {
      displayName: patch.displayName ?? existing.displayName,
      avatarUrl: "avatarUrl" in patch ? patch.avatarUrl : existing.avatarUrl,
      bio: "bio" in patch ? patch.bio : existing.bio,
      theme: "theme" in patch ? patch.theme : existing.theme,
      metadata: patch.metadata ?? existing.metadata
    };
    return this.upsert({
      tenantId,
      actorId,
      displayName: next.displayName,
      avatarUrl: next.avatarUrl,
      bio: next.bio,
      theme: next.theme,
      metadata: next.metadata
    });
  }

  async delete({ tenantId, actorId }) {
    const result = await this.pool.query(
      `DELETE FROM agents WHERE tenant_id = $1 AND agent_id = $2`,
      [tenantId, actorId]
    );
    return result.rowCount > 0;
  }

  async list({ tenantId, actorId, limit = 200 } = {}) {
    const max = Math.max(1, Math.min(Number(limit) || 200, 1000));
    const where = [];
    const params = [];
    if (tenantId) {
      params.push(tenantId);
      where.push(`tenant_id = $${params.length}`);
    }
    if (actorId) {
      params.push(actorId);
      where.push(`agent_id = $${params.length}`);
    }
    params.push(max);
    const sql = `
      SELECT tenant_id, agent_id, display_name, avatar_url, bio, metadata, created_at, updated_at
      FROM agents
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY updated_at DESC
      LIMIT $${params.length}
    `;
    const result = await this.pool.query(sql, params);
    return result.rows.map(mapRow);
  }
}
