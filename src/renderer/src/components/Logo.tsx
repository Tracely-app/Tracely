import { BrandMark } from './icons'

// The brand mark, as a block — kept as a default export with its `size` prop
// so FloatingApp's header still compiles. The artwork itself (figma-logo.png)
// and the inverted variant live in icons.tsx with the rest of the set.
export default function Logo({ size = 24 }: { size?: number }): JSX.Element {
  return <BrandMark size={size} />
}
