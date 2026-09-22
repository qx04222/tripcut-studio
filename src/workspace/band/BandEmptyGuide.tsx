import { Button } from "../ui";
export function BandEmptyGuide({ disabled, busy, arrange }: { disabled: boolean; busy: boolean; arrange(): void }) {
  return <div className="band-empty-guide">
    <span>按 F 收藏几条,再点一键排入</span>
    <Button variant="secondary" size="sm" disabled={disabled} busy={busy} onClick={arrange}>一键排入</Button>
  </div>;
}
