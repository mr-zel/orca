import type { ComponentType } from 'react'
import { Pressable } from 'react-native'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-session-styles'

type HeaderIconProps = {
  size?: number
  color?: string
  strokeWidth?: number
}

type MobileSessionHeaderIconButtonProps = {
  active?: boolean
  accessibilityLabel: string
  icon: ComponentType<HeaderIconProps>
  onPress: () => void
  /** Второе действие на той же кнопке — шапка узкая, а режимов у динамика два. */
  onLongPress?: () => void
}

export function MobileSessionHeaderIconButton({
  active = false,
  accessibilityLabel,
  icon: Icon,
  onPress,
  onLongPress
}: MobileSessionHeaderIconButtonProps) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.filesButton,
        pressed && styles.filesButtonPressed,
        active && styles.filesButtonActive
      ]}
      onPress={onPress}
      onLongPress={onLongPress}
      hitSlop={8}
      accessibilityLabel={accessibilityLabel}
    >
      <Icon size={18} color={colors.textSecondary} strokeWidth={2.1} />
    </Pressable>
  )
}
