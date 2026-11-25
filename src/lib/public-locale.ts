/**
 * Shared localization for public subscriber-facing pages (polls, surveys).
 * Resolves from the contact's `lang`/`locale` property first, then `Accept-Language`, else `en`.
 */

export type PublicLocale = "en" | "es" | "fr" | "de" | "pt" | "ru" | "uk";

const SUPPORTED = new Set<PublicLocale>(["en", "es", "fr", "de", "pt", "ru", "uk"]);

function normLocale(raw: unknown): PublicLocale | null {
	if (typeof raw !== "string") return null;
	const code = raw.trim().toLowerCase().slice(0, 2) as PublicLocale;
	return SUPPORTED.has(code) ? code : null;
}

/** Picks the best supported locale from an explicit value (e.g. contact.properties.lang) and Accept-Language. */
export function resolvePublicLocale(
	preferred: unknown,
	acceptLanguage?: string | null,
): PublicLocale {
	const direct = normLocale(preferred);
	if (direct) return direct;
	if (acceptLanguage) {
		for (const part of acceptLanguage.split(",")) {
			const tag = part.split(";")[0]?.trim();
			const hit = normLocale(tag);
			if (hit) return hit;
		}
	}
	return "en";
}

export interface PollWords {
	pick: string;
	thanks: string;
	changed: string;
	yourAnswer: string;
	readOnline: string;
	notFoundTitle: string;
	notFoundBody: string;
	fromEmailTitle: string;
	fromEmailBody: string;
	openLink: string;
}

const POLL_WORDS: Record<PublicLocale, PollWords> = {
	en: {
		pick: "Pick an answer.",
		thanks: "Thanks, your answer is in. Here's how everyone answered so far.",
		changed: "Changed your mind? Pick another answer.",
		yourAnswer: "Your answer",
		readOnline: "Read the issue online",
		notFoundTitle: "This poll isn't available",
		notFoundBody: "The link may be incomplete.",
		fromEmailTitle: "Answer from your email",
		fromEmailBody:
			"This poll counts answers from the email it came in: open it there and pick your answer.",
		openLink: "Continue",
	},
	es: {
		pick: "Elige una respuesta.",
		thanks: "Gracias, registramos tu respuesta. Así respondieron los demás hasta ahora.",
		changed: "¿Cambiaste de opinión? Elige otra respuesta.",
		yourAnswer: "Tu respuesta",
		readOnline: "Leer esta edición en línea",
		notFoundTitle: "Esta encuesta no está disponible",
		notFoundBody: "Es posible que el enlace esté incompleto.",
		fromEmailTitle: "Responde desde tu correo",
		fromEmailBody:
			"Esta encuesta cuenta las respuestas desde el correo en el que llegó: ábrelo allí y elige tu respuesta.",
		openLink: "Continuar",
	},
	fr: {
		pick: "Choisissez une réponse.",
		thanks: "Merci, votre réponse est enregistrée. Voici les résultats jusqu'ici.",
		changed: "Vous avez changé d'avis ? Choisissez une autre réponse.",
		yourAnswer: "Votre réponse",
		readOnline: "Lire ce numéro en ligne",
		notFoundTitle: "Ce sondage n'est pas disponible",
		notFoundBody: "Le lien est peut-être incomplet.",
		fromEmailTitle: "Répondez depuis votre e-mail",
		fromEmailBody:
			"Ce sondage enregistre les réponses depuis l'e-mail reçu : ouvrez-le et choisissez votre réponse.",
		openLink: "Continuer",
	},
	de: {
		pick: "Wähle eine Antwort.",
		thanks: "Danke, deine Antwort wurde gespeichert. So haben die anderen bisher abgestimmt.",
		changed: "Meinung geändert? Wähle eine andere Antwort.",
		yourAnswer: "Deine Antwort",
		readOnline: "Ausgabe online lesen",
		notFoundTitle: "Diese Umfrage ist nicht verfügbar",
		notFoundBody: "Der Link ist möglicherweise unvollständig.",
		fromEmailTitle: "Aus deiner E-Mail antworten",
		fromEmailBody:
			"Diese Umfrage zählt Antworten aus der erhaltenen E-Mail: Öffne sie dort und wähle deine Antwort.",
		openLink: "Weiter",
	},
	pt: {
		pick: "Escolha uma resposta.",
		thanks: "Obrigado, sua resposta foi registrada. Veja como os outros responderam até agora.",
		changed: "Mudou de ideia? Escolha outra resposta.",
		yourAnswer: "Sua resposta",
		readOnline: "Ler esta edição online",
		notFoundTitle: "Esta enquete não está disponível",
		notFoundBody: "O link pode estar incompleto.",
		fromEmailTitle: "Responda pelo seu e-mail",
		fromEmailBody:
			"Esta enquete registra respostas pelo e-mail recebido: abra-o lá e escolha sua resposta.",
		openLink: "Continuar",
	},
	ru: {
		pick: "Выберите ответ.",
		thanks: "Спасибо, ответ записан. Вот как ответили остальные.",
		changed: "Передумали? Выберите другой ответ.",
		yourAnswer: "Ваш ответ",
		readOnline: "Читать выпуск онлайн",
		notFoundTitle: "Этот опрос недоступен",
		notFoundBody: "Возможно, ссылка неполная.",
		fromEmailTitle: "Ответьте из письма",
		fromEmailBody:
			"Этот опрос учитывает ответы из письма: откройте его там и выберите ваш вариант.",
		openLink: "Перейти",
	},
	uk: {
		pick: "Оберіть відповідь.",
		thanks: "Дякуємо, відповідь записано. Ось як відповіли інші.",
		changed: "Передумали? Оберіть іншу відповідь.",
		yourAnswer: "Ваша відповідь",
		readOnline: "Читати випуск онлайн",
		notFoundTitle: "Це опитування недоступне",
		notFoundBody: "Можливо, посилання неповне.",
		fromEmailTitle: "Відповідайте з листа",
		fromEmailBody:
			"Це опитування враховує відповіді з листа: відкрийте його там і оберіть свій варіант.",
		openLink: "Перейти",
	},
};

export const pollWords = (locale: PublicLocale): PollWords => POLL_WORDS[locale] ?? POLL_WORDS.en;

export interface SurveyWords {
	send: string;
	optional: string;
	pickFirst: string;
	closedTitle: string;
	closedBody: string;
	notFoundTitle: string;
	notFoundBody: string;
	thankYou: string;
	commentRecorded: string;
	answerRecorded: string;
	pressSend: string;
	answerInComment: string;
	answerInThanks: string;
	rateLimitTitle: string;
	rateLimitBody: string;
}

const SURVEY_WORDS: Record<PublicLocale, SurveyWords> = {
	en: {
		send: "Send",
		optional: "optional",
		pickFirst: "Pick an answer first.",
		closedTitle: "This survey is closed",
		closedBody: "Thanks for wanting to answer.",
		notFoundTitle: "This survey isn't available",
		notFoundBody: "The link may be incomplete.",
		thankYou: "Thank you",
		commentRecorded: "Your comment is with the team.",
		answerRecorded: "Your answer is recorded.",
		pressSend: "Press Send to record your answer.",
		answerInComment: "Your answer is in. Add a comment if you like.",
		answerInThanks: "Your answer is in. Thank you!",
		rateLimitTitle: "One moment",
		rateLimitBody: "Too many answers from here; try again in a minute.",
	},
	es: {
		send: "Enviar",
		optional: "opcional",
		pickFirst: "Elige una respuesta primero.",
		closedTitle: "Esta encuesta está cerrada",
		closedBody: "Gracias por querer responder.",
		notFoundTitle: "Esta encuesta no está disponible",
		notFoundBody: "Es posible que el enlace esté incompleto.",
		thankYou: "Gracias",
		commentRecorded: "Tu comentario llegó al equipo.",
		answerRecorded: "Tu respuesta fue registrada.",
		pressSend: "Pulsa Enviar para registrar tu respuesta.",
		answerInComment: "Tu respuesta fue registrada. Agrega un comentario si quieres.",
		answerInThanks: "Tu respuesta fue registrada. ¡Gracias!",
		rateLimitTitle: "Un momento",
		rateLimitBody: "Demasiadas respuestas desde aquí; intenta de nuevo en un minuto.",
	},
	fr: {
		send: "Envoyer",
		optional: "facultatif",
		pickFirst: "Choisissez d'abord une réponse.",
		closedTitle: "Ce sondage est fermé",
		closedBody: "Merci d'avoir voulu répondre.",
		notFoundTitle: "Ce sondage n'est pas disponible",
		notFoundBody: "Le lien est peut-être incomplet.",
		thankYou: "Merci",
		commentRecorded: "Votre commentaire a été transmis à l'équipe.",
		answerRecorded: "Votre réponse est enregistrée.",
		pressSend: "Appuyez sur Envoyer pour enregistrer votre réponse.",
		answerInComment:
			"Votre réponse est enregistrée. Ajoutez un commentaire si vous le souhaitez.",
		answerInThanks: "Votre réponse est enregistrée. Merci !",
		rateLimitTitle: "Un instant",
		rateLimitBody: "Trop de réponses d'ici ; réessayez dans une minute.",
	},
	de: {
		send: "Senden",
		optional: "optional",
		pickFirst: "Wähle zuerst eine Antwort.",
		closedTitle: "Diese Umfrage ist geschlossen",
		closedBody: "Danke für dein Interesse.",
		notFoundTitle: "Diese Umfrage ist nicht verfügbar",
		notFoundBody: "Der Link ist möglicherweise unvollständig.",
		thankYou: "Danke",
		commentRecorded: "Dein Kommentar wurde an das Team gesendet.",
		answerRecorded: "Deine Antwort wurde gespeichert.",
		pressSend: "Klicke auf Senden, um deine Antwort zu speichern.",
		answerInComment: "Deine Antwort wurde gespeichert. Füge gern einen Kommentar hinzu.",
		answerInThanks: "Deine Antwort wurde gespeichert. Vielen Dank!",
		rateLimitTitle: "Einen Moment",
		rateLimitBody: "Zu viele Antworten von hier; versuche es in einer Minute erneut.",
	},
	pt: {
		send: "Enviar",
		optional: "opcional",
		pickFirst: "Escolha uma resposta primeiro.",
		closedTitle: "Esta pesquisa está encerrada",
		closedBody: "Obrigado por querer responder.",
		notFoundTitle: "Esta pesquisa não está disponível",
		notFoundBody: "O link pode estar incompleto.",
		thankYou: "Obrigado",
		commentRecorded: "Seu comentário foi enviado para a equipe.",
		answerRecorded: "Sua resposta foi registrada.",
		pressSend: "Clique em Enviar para registrar sua resposta.",
		answerInComment: "Sua resposta foi registrada. Adicione um comentário se quiser.",
		answerInThanks: "Sua resposta foi registrada. Obrigado!",
		rateLimitTitle: "Um momento",
		rateLimitBody: "Muitas respostas daqui; tente novamente em um minuto.",
	},
	ru: {
		send: "Отправить",
		optional: "необязательно",
		pickFirst: "Сначала выберите ответ.",
		closedTitle: "Этот опрос закрыт",
		closedBody: "Спасибо за желание ответить.",
		notFoundTitle: "Этот опрос недоступен",
		notFoundBody: "Возможно, ссылка неполная.",
		thankYou: "Спасибо",
		commentRecorded: "Ваш комментарий передан команде.",
		answerRecorded: "Ваш ответ записан.",
		pressSend: "Нажмите «Отправить», чтобы записать ответ.",
		answerInComment: "Ваш ответ записан. При желании добавьте комментарий.",
		answerInThanks: "Ваш ответ записан. Спасибо!",
		rateLimitTitle: "Секундочку",
		rateLimitBody: "Слишком много ответов; попробуйте снова через минуту.",
	},
	uk: {
		send: "Надіслати",
		optional: "необов'язково",
		pickFirst: "Спочатку оберіть відповідь.",
		closedTitle: "Це опитування закрите",
		closedBody: "Дякуємо за бажання відповісти.",
		notFoundTitle: "Це опитування недоступне",
		notFoundBody: "Можливо, посилання неповне.",
		thankYou: "Дякуємо",
		commentRecorded: "Ваш коментар передано команді.",
		answerRecorded: "Вашу відповідь записано.",
		pressSend: "Натисніть «Надіслати», щоб записати відповідь.",
		answerInComment: "Вашу відповідь записано. За бажанням додайте коментар.",
		answerInThanks: "Вашу відповідь записано. Дякуємо!",
		rateLimitTitle: "Хвилинку",
		rateLimitBody: "Забагато відповідей; спробуйте ще раз за хвилину.",
	},
};

export const surveyWords = (locale: PublicLocale): SurveyWords =>
	SURVEY_WORDS[locale] ?? SURVEY_WORDS.en;
