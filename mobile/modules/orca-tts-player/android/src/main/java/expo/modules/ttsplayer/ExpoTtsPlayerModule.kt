package expo.modules.ttsplayer

import android.media.AudioAttributes
import android.media.MediaPlayer
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Почему отдельный модуль, а не playPCMData из @orca/expo-two-way-audio: тот движок
// играет строго 16 кГц моно PCM, а наш TTS-движок отдаёт WAV другой частоты — без
// ресемплинга голос едет по темпу. MediaPlayer ест WAV/MP3 по URL как есть.
// USAGE_NOTIFICATION: речь агента — это уведомление, а не музыка. Беззвучный режим и
// «не беспокоить» её глушат (по слову оператора: «пусть глушит беззвучный»), и чужой
// фокус аудио она не требует.
class ExpoTtsPlayerModule : Module() {
  private var player: MediaPlayer? = null
  private var pending: Promise? = null

  override fun definition() = ModuleDefinition {
    Name("ExpoTtsPlayer")

    AsyncFunction("play") { url: String, promise: Promise ->
      releasePlayer()
      // Тот вызов мы только что оборвали, а его обещание никто не закрыл: закрываем сами,
      // иначе JS-сторона ждала бы завершения озвучки навсегда.
      val interrupted = pending
      pending = null
      interrupted?.resolve(false)
      pending = promise
      val mp = MediaPlayer()
      player = mp
      try {
        mp.setAudioAttributes(
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION)
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
