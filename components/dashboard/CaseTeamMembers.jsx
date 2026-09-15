export default function CaseTeamMembers({ users = [] }) {
  const members = users.filter(Boolean);
  if (!members.length) return <span>—</span>;

  const names = members.map((user) => user.name).join(", ");
  return (
    <div className="case-team-members" title={names} role="group" aria-label={`Team Members: ${names}`}>
      {members.map((user) => (
        <span key={user.id} title={user.name}>{user.name}</span>
      ))}
    </div>
  );
}
