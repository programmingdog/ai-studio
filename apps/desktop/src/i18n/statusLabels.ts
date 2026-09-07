import type { AppLocale } from "./locales";

const statusLabels: Record<AppLocale, Record<string, string>> = {
  "zh-CN": { CREATED: "待支付", PENDING: "处理中", PROCESSING: "处理中", PAID: "已支付", CANCELED: "已取消", CANCELLED: "已取消", EXPIRED: "已过期", FAILED: "失败", CONFIRMED: "已确认", SUCCEEDED: "已成功", COMPLETED: "已完成", HELD: "已冻结", RELEASED: "已释放", REFUNDED: "已退款" },
  "zh-TW": { CREATED: "待付款", PENDING: "處理中", PROCESSING: "處理中", PAID: "已付款", CANCELED: "已取消", CANCELLED: "已取消", EXPIRED: "已過期", FAILED: "失敗", CONFIRMED: "已確認", SUCCEEDED: "已成功", COMPLETED: "已完成", HELD: "已凍結", RELEASED: "已釋放", REFUNDED: "已退款" },
  en: { CREATED: "Awaiting payment", PENDING: "Pending", PROCESSING: "Processing", PAID: "Paid", CANCELED: "Canceled", CANCELLED: "Canceled", EXPIRED: "Expired", FAILED: "Failed", CONFIRMED: "Confirmed", SUCCEEDED: "Succeeded", COMPLETED: "Completed", HELD: "Held", RELEASED: "Released", REFUNDED: "Refunded" },
  ja: { CREATED: "支払い待ち", PENDING: "処理待ち", PROCESSING: "処理中", PAID: "支払い済み", CANCELED: "キャンセル済み", CANCELLED: "キャンセル済み", EXPIRED: "期限切れ", FAILED: "失敗", CONFIRMED: "確認済み", SUCCEEDED: "成功", COMPLETED: "完了", HELD: "保留中", RELEASED: "解放済み", REFUNDED: "返金済み" },
  ko: { CREATED: "결제 대기", PENDING: "대기 중", PROCESSING: "처리 중", PAID: "결제 완료", CANCELED: "취소됨", CANCELLED: "취소됨", EXPIRED: "만료됨", FAILED: "실패", CONFIRMED: "확인됨", SUCCEEDED: "성공", COMPLETED: "완료", HELD: "보류 중", RELEASED: "해제됨", REFUNDED: "환불됨" },
  fr: { CREATED: "Paiement en attente", PENDING: "En attente", PROCESSING: "En cours", PAID: "Payé", CANCELED: "Annulé", CANCELLED: "Annulé", EXPIRED: "Expiré", FAILED: "Échec", CONFIRMED: "Confirmé", SUCCEEDED: "Réussi", COMPLETED: "Terminé", HELD: "Bloqué", RELEASED: "Libéré", REFUNDED: "Remboursé" },
  es: { CREATED: "Pendiente de pago", PENDING: "Pendiente", PROCESSING: "Procesando", PAID: "Pagado", CANCELED: "Cancelado", CANCELLED: "Cancelado", EXPIRED: "Caducado", FAILED: "Fallido", CONFIRMED: "Confirmado", SUCCEEDED: "Correcto", COMPLETED: "Completado", HELD: "Retenido", RELEASED: "Liberado", REFUNDED: "Reembolsado" },
  pt: { CREATED: "Aguardando pagamento", PENDING: "Pendente", PROCESSING: "Processando", PAID: "Pago", CANCELED: "Cancelado", CANCELLED: "Cancelado", EXPIRED: "Expirado", FAILED: "Falhou", CONFIRMED: "Confirmado", SUCCEEDED: "Sucesso", COMPLETED: "Concluído", HELD: "Retido", RELEASED: "Liberado", REFUNDED: "Reembolsado" },
  de: { CREATED: "Zahlung ausstehend", PENDING: "Ausstehend", PROCESSING: "In Bearbeitung", PAID: "Bezahlt", CANCELED: "Storniert", CANCELLED: "Storniert", EXPIRED: "Abgelaufen", FAILED: "Fehlgeschlagen", CONFIRMED: "Bestätigt", SUCCEEDED: "Erfolgreich", COMPLETED: "Abgeschlossen", HELD: "Reserviert", RELEASED: "Freigegeben", REFUNDED: "Erstattet" },
  bo: { CREATED: "དངུལ་སྤྲོད་རྒྱུར་སྒུག་པ།", PENDING: "སྒུག་བཞིན་པ།", PROCESSING: "སྒྲུབ་བཞིན་པ།", PAID: "དངུལ་སྤྲད་ཟིན།", CANCELED: "ཕྱིར་འཐེན་ཟིན།", CANCELLED: "ཕྱིར་འཐེན་ཟིན།", EXPIRED: "དུས་ཚོད་ཡོལ།", FAILED: "ཕམ་པ།", CONFIRMED: "གཏན་འཁེལ།", SUCCEEDED: "ལེགས་གྲུབ།", COMPLETED: "ལེགས་གྲུབ།", HELD: "བཀག་ཉར།", RELEASED: "གློད་ཟིན།", REFUNDED: "དངུལ་ཕྱིར་སློག་ཟིན།" },
  ug: { CREATED: "تۆلەشنى كۈتۈۋاتىدۇ", PENDING: "كۈتۈۋاتىدۇ", PROCESSING: "بىر تەرەپ قىلىنىۋاتىدۇ", PAID: "تۆلەندى", CANCELED: "بىكار قىلىندى", CANCELLED: "بىكار قىلىندى", EXPIRED: "ۋاقتى ئۆتتى", FAILED: "مەغلۇپ بولدى", CONFIRMED: "جەزملەندى", SUCCEEDED: "مۇۋەپپەقىيەتلىك", COMPLETED: "تاماملاندى", HELD: "تۇتۇپ قېلىندى", RELEASED: "قويۇپ بېرىلدى", REFUNDED: "پۇل قايتۇرۇلدى" },
  mn: { CREATED: "Төлбөр хүлээгдэж байна", PENDING: "Хүлээгдэж байна", PROCESSING: "Боловсруулж байна", PAID: "Төлсөн", CANCELED: "Цуцлагдсан", CANCELLED: "Цуцлагдсан", EXPIRED: "Хугацаа дууссан", FAILED: "Амжилтгүй", CONFIRMED: "Баталгаажсан", SUCCEEDED: "Амжилттай", COMPLETED: "Дууссан", HELD: "Түгжигдсэн", RELEASED: "Чөлөөлөгдсөн", REFUNDED: "Буцаан олгосон" },
};

export function localizedStatusLabel(status: string, locale: AppLocale): string {
  const normalized = String(status || "").trim().toUpperCase();
  return statusLabels[locale]?.[normalized] || statusLabels.en[normalized] || status || "—";
}
