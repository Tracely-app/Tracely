import type { ButtonHTMLAttributes } from 'react'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'dark'
  /** 28px tall, 13px label — for toolbars and card footers. */
  size?: 'sm'
  /** A 28x28 square with no padding; pass an aria-label with the icon. */
  icon?: boolean
}

export default function Button({
  variant = 'secondary',
  size,
  icon,
  className,
  ...rest
}: ButtonProps): JSX.Element {
  const cls = ['btn', `btn-${variant}`, size === 'sm' ? 'btn-sm' : '', icon ? 'btn-icon' : '', className ?? '']
    .filter(Boolean)
    .join(' ')
  return <button className={cls} {...rest} />
}
