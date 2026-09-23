/**
 * マイクの利用許可が「すでに」下りているか。
 * 「今日の一本」や「もう 1 回」から autoRecord で開いたスレッド画面が、勝手に録音を始めてよいかの判定に使う。
 * 初回は許可ダイアログが出るので「開いたら勝手に録音し始めた」に見せないため、granted のときだけ true。
 * Permissions API 非対応(古い Safari など)や例外は false にして、従来どおりボタンを押してもらう。
 */
export async function micPermissionGranted(): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.permissions?.query) return false
    const status = await navigator.permissions.query({ name: 'microphone' as PermissionName })
    return status.state === 'granted'
  } catch {
    return false
  }
}
