import { formatViloDateTime } from "../lib/dateFormat";

export default function DocumentLastEdited({ document }) {
  if (!document?.last_edited_at || !document?.last_edited_by_name) return null;
  const when = formatViloDateTime(document.last_edited_at).replace(", ", " at ");
  return <small className="document-last-edited">Last edited by {document.last_edited_by_name} on {when}</small>;
}
