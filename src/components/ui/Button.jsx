import React from 'react';

/**
 * Reusable Button component
 * @param {Object} props
 * @param {React.ReactNode} props.children
 * @param {'primary' | 'secondary' | 'ghost' | 'outline'} [props.variant='secondary']
 * @param {'sm' | 'md' | 'icon' | 'icon-round'} [props.size='md']
 * @param {string} [props.className='']
 * @param {React.ReactNode} [props.icon]
 * @param {() => void} [props.onClick]
 * @param {boolean} [props.disabled=false]
 * @param {'button' | 'submit' | 'reset'} [props.type='button']
 * @param {string} [props.title]
 * @param {string} [props.ariaLabel]
 */
export default function Button({
  children,
  variant = 'secondary',
  size = 'md',
  className = '',
  icon,
  onClick,
  disabled = false,
  type = 'button',
  title,
  ariaLabel,
  ...rest
}) {
  const variantClass = `btn-${variant}`;
  const sizeClass = `btn-${size}`;
  const combinedClasses = `btn ${variantClass} ${sizeClass} ${className}`.trim();

  return (
    <button
      type={type}
      className={combinedClasses}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel || title}
      {...rest}
    >
      {icon && <span className="btn-icon-wrapper" aria-hidden="true">{icon}</span>}
      {children}
    </button>
  );
}
