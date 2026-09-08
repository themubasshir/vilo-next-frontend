export default function AssignedParalegals({ users = [] }) {
  const paralegals = users.filter((user) => user.role === "paralegal");
  if (!paralegals.length) return <span>—</span>;

  const names = paralegals.map((user) => user.name).join(", ");
  return (
    <div className="case-paralegals" title={names} role="group" aria-label={`Assigned Paralegals: ${names}`}>
      {paralegals.slice(0, 2).map((user) => (
        <span key={user.id} title={user.name}>{user.name}</span>
      ))}
      {paralegals.length > 2 ? (
        <span aria-label={paralegals.slice(2).map((user) => user.name).join(", ")}>+{paralegals.length - 2} more</span>
      ) : null}
    </div>
  );
}
