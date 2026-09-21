import { invoke } from "@tauri-apps/api/core";
export interface ArchiveOperation {
  id: string;
  kind: "kit" | "bundle" | "photo";
  status: "planned" | "running" | "partial" | "done" | "undoing" | "undone" | "failed";
  destination: string;
  job_id: number | null;
  needs_preparation: boolean;
  undo_requested?: boolean;
  errors: string[];
  files?: { source: string; destination: string; size: number; source_hash: string; derived: boolean; status: string }[];
}
export const listArchives = () => invoke<ArchiveOperation[]>("list_archive_ops");
export const resumeArchive = (id: string) => invoke<ArchiveOperation>("resume_archive", { id });
export const undoArchive = (id: string) => invoke<ArchiveOperation>("undo_archive", { id });
