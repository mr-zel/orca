package expo.modules.ttsplayer

import android.media.AudioAttributes
import android.media.MediaPlayer
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Почему отдельный модуль, а не playPCMData из @orca/expo-two-way-audio: тот движок
// играет строго 16 кГц моно PCM, а наш TTS-движок отдаёт WAV другой частоты — без
// ресемплинга голос едет по темпу. MediaPlayer ест WAV/MP3 по URL как есть.
// USAGE_ASSISTANCE_ACCESSIBILITY — речь, а не музыка: играет даже при беззвучном
// режиме и не требует аудиососредоточения, которого нам терять нечего.
class ExpoTtsPlayerModule : Module() {
  private var player: MediaPlayer? = null
  private var pending: Promise? = null

  override fun definition() = ModuleDefinition {
    Name("ExpoTtsPlayer")

    AsyncFunction("play") { url: String, promise: Promise ->
      releasePlayer()
      pending = promise
      val mp = MediaPlayer()
      player = mp
      try {
        mp.setAudioAttributes(
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ASSISTANCE_ACCESSIBILITY)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()
        )
        mp.setOnCompletionListener { settle(mp, true) }
        mp.setOnErrorListener { _, _, _ ->
          settle(mp, false)
          true
        }
        mp.setOnPreparedListener { it.start() }
        mp.setDataSource(url)
        mp.prepareAsync()
      } catch (e: Exception) {
        settle(mp, false)
      }
    }

    Function("stop") {
      releasePlayer()
      val p = pending
      pending = null
      p?.resolve(false)
      null
    }

    Function("isPlaying") {
      player?.isPlaying ?: false
    }
  }

  private fun settle(mp: MediaPlayer, ok: Boolean) {
    if (player === mp) {
      releasePlayer()
    }
    val p = pending
    pending = null
    p?.resolve(ok)
  }

  private fun releasePlayer() {
    val mp = player ?: return
    player = null
    runCatching {
      if (mp.isPlaying) {
        mp.stop()
      }
    }
    runCatching { mp.release() }
  }
}
