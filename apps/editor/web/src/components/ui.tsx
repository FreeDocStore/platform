export function Field({
  label,
  value,
  onChange,
  placeholder,
  secret,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  secret?: boolean
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} type={secret ? 'password' : 'text'} />
    </label>
  )
}
