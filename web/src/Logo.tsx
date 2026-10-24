/** Ngôi sao sự sống (Star of Life) – biểu tượng chung của cấp cứu ngoại viện */
export function StarOfLife({ size = 32 }: { size?: number }) {
  return <img src="/logo.svg" width={size} height={size} alt="" aria-hidden="true" style={{ display: 'block' }} />;
}

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand">
      <StarOfLife size={compact ? 30 : 56} />
      <div>
        <div className="brand-name">Medone</div>
        {!compact && <div className="brand-sub">Dịch vụ Chuyển viện – Cấp cứu ngoại viện</div>}
      </div>
    </div>
  );
}
