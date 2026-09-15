export default function CaseAssignees({ users = [] }) {
  const assignees = users.filter(Boolean);
  if (!assignees.length) return <span>—</span>;

  const names = assignees.map((user) => user.name).join(", ");
  return (
    <div className="case-assignees" title={names} role="group" aria-label={`Assignees: ${names}`}>
      {assignees.slice(0, 2).map((user) => (
        <span key={user.id} title={user.name}>{user.name}</span>
      ))}
      {assignees.length > 2 ? (
        <span aria-label={assignees.slice(2).map((user) => user.name).join(", ")}>+{assignees.length - 2} more</span>
      ) : null}
    </div>
  );
}
