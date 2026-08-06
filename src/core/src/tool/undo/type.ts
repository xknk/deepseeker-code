/**
 * @file tool/undo/type.ts
 * @description 文件回退（Undo）机制的类型定义：
 *  UndoRecord（单次文件变更的备份索引记录）、BackupKind、UndoOperationType。
 */
/** 受 Undo 管理的变更工具集合（与四个 fs 写工具 + notebook_edit 一一对应）。 */
export type UndoOperationType = 'edit_file' | 'write_file' | 'create_file' | 'delete_path' | 'notebook_edit';

/**
 * 备份内容形态：
 *  - file_content   单文件全文备份（edit/write 覆盖、delete 删文件）
 *  - directory_tree 整目录树快照（delete_path 删目录，cpSync 还原结构）
 *  - creation_marker 仅作"新建标记"（create_file 或 write_file 新建）：原文件不存在，回退=删除新建文件
 */
export type BackupKind = 'file_content' | 'directory_tree' | 'creation_marker';

/** 敏感文件（.env/私钥/凭证等）的备份策略，对应 appConfig.undoBackupSensitive。 */
export type SensitivePolicy = 'skip' | 'deny' | 'allow';

/**
 * 单次变更的备份索引记录（每行一个，写入 undo-YYYY-MM-DD__主id.jsonl）。
 * 备份内容本体存于 backups/<undoId>/，与索引解耦。
 */
export interface UndoRecord {
    /** 自造主键（createUUID），回退工具的入参；即使 toolsId 已唯一，仍利于建独立索引与"一调多记录"。 */
    undoId: string;
    /** = toolCall.id，外键关联 trace(metadata.tools_id)/transcript/审批系统，便于交叉检索。 */
    toolsId: string;
    /** 完整 sessionId（含 __sub__ 后缀），便于回溯发起者；归档目录由 getFileName 剥后缀。 */
    sessionId: string;
    /** 产生本次变更的工具名。 */
    operationType: UndoOperationType;
    /** 相对 WORKSPACE_ROOT 的 POSIX 路径（正斜杠），回退时喂给 resolveSafePath。 */
    relativePath: string;
    /** 备份内容形态，决定回退分发逻辑。 */
    backupKind: BackupKind;
    /** 备份内容本体的绝对路径（backups/<undoId>/{content|tree}）；creation_marker 时为空串。
     *  注：仅作审计/溯源用——回退逻辑（restore.ts dispatchRestore）按 undoId 重新拼接路径、不读取此字段。 */
    backupPath: string;
    /** 原内容 SHA-1（hex），覆盖式回退前的脏写检测用；creation_marker 时缺省。 */
    contentHashBefore?: string;
    /** 原字节数，清理水位估算 + 回退回执展示用。 */
    fileSizeBefore?: number;
    /** 落盘 ISO 时间戳（emit 时注入）。 */
    timestamp: string;
    /** 'YYYY-MM-DD' 初生日期，对齐索引文件名前缀，供清理判定。 */
    bornDate: string;
    /** 入参截断快照（全量已在 trace，这里只放人可读提示，避免放大敏感数据）。 */
    argsSnapshot?: { old_str?: string; new_str?: string; contentLength?: number };
    /** 已被回退过则 true，防重复回退。 */
    restored?: boolean;
    /** 反向回退产生的记录 id（链表，支持"撤销撤销"）。 */
    reverseUndoId?: string;
}
