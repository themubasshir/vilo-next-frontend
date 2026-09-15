"use client";

import { useEffect, useRef, useState } from "react";
import {
  formatViloDateInput,
  formatViloDateTimeInput,
  toIsoDateFromViloInput,
  toLocalDateTimeFromViloInput,
} from "../lib/dateFormat";

export default function ViloDateInput({ value, onChange, onBlur, required = false, includeTime = false, ...props }) {
  const formatter = includeTime ? formatViloDateTimeInput : formatViloDateInput;
  const parser = includeTime ? toLocalDateTimeFromViloInput : toIsoDateFromViloInput;
  const [displayValue, setDisplayValue] = useState(() => formatter(value));
  const previousValue = useRef(value);
  const inputRef = useRef(null);

  useEffect(() => {
    const formattedValue = formatter(value);
    const changedExternally = value !== previousValue.current;
    const shouldResetInactiveInput = inputRef.current !== document.activeElement && displayValue !== formattedValue;
    if (changedExternally || shouldResetInactiveInput) {
      previousValue.current = value;
      setDisplayValue(formattedValue);
      inputRef.current?.setCustomValidity("");
    }
  });

  function update(event) {
    const raw = event.target.value;
    const parsed = parser(raw);
    setDisplayValue(raw);
    event.target.setCustomValidity(
      raw && parsed === null
        ? includeTime
          ? "Use date and time format DD/MM/YYYY, h:mm AM/PM."
          : "Use date format DD/MM/YYYY."
        : "",
    );
    if (parsed !== null) {
      previousValue.current = parsed;
      onChange(parsed);
    }
  }

  function finishEditing(event) {
    const parsed = parser(event.target.value);
    if (parsed !== null) setDisplayValue(formatter(parsed));
    onBlur?.(event);
  }

  return (
    <input
      ref={inputRef}
      {...props}
      type="text"
      value={displayValue}
      onChange={update}
      onBlur={finishEditing}
      required={required}
      placeholder={includeTime ? "DD/MM/YYYY, h:mm AM/PM" : "DD/MM/YYYY"}
      inputMode={includeTime ? "text" : "numeric"}
      maxLength={includeTime ? 22 : 10}
    />
  );
}
