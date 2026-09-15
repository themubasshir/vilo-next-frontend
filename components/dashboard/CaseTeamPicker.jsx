export default function CaseTeamPicker({ team = [], selectedIds = [], onToggle }) {
  const selected = new Set(selectedIds.map(Number));
  return (
    <fieldset className="case-team-picker">
      <legend>Team Members</legend>
      <p className="case-team-picker__count">{selected.size} Team {selected.size === 1 ? "Member" : "Members"} selected</p>
      <div className="case-team-picker__list">
        {team.map((member) => (
          <label key={member.id} className={`case-team-picker__option${selected.has(Number(member.id)) ? " is-selected" : ""}`}>
            <input
              type="checkbox"
              checked={selected.has(Number(member.id))}
              onChange={() => onToggle(Number(member.id))}
            />
            <span>{member.name}</span>
            <small>{member.role}</small>
          </label>
        ))}
      </div>
      {!team.length ? <p className="case-assigned-empty">No staff are available.</p> : null}
    </fieldset>
  );
}
