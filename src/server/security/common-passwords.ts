/**
 * Local denylist of the most common leaked passwords (PROD-203), lower-cased.
 * It works without internet egress; the optional HIBP range check covers the
 * long tail. Entries shorter than the 12-character minimum still matter for
 * the "common base word plus trailing digits" rule in password-policy.ts.
 */
const ENTRIES = `
password passw0rd p@ssw0rd p@ssword password1 password12 password123 password1234 password12345 password123456
password1! password! senha senha123 senha1234 senha12345 senha123456 senhasenha minhasenha minhasenha123 mudar123 mudar1234
123456 1234567 12345678 123456789 1234567890 12345678910 123123 1234 12345 111111 000000 121212 654321 666666 7777777 123321 112233 102030 159753 147258369 987654321 9876543210
123456789012 111111111111 000000000000 123456123456 123123123123 1234567890123 abc123 abc12345 abc123456 abcd1234 abcd12345 abcd123456 abcdef123456 abcdefghijkl 1q2w3e 1q2w3e4r 1q2w3e4r5t 1q2w3e4r5t6y 1qaz2wsx 1qaz2wsx3edc qazwsxedc qazwsx123 zaq12wsx
qwerty qwerty1 qwerty12 qwerty123 qwerty1234 qwerty12345 qwerty123456 qwertyuiop qwertyuiop123 qwertyui asdfgh asdfghjkl asdfghjkl123 asdf1234 asdfasdf zxcvbn zxcvbnm zxcvbnm123 qweasdzxc qwe123 qwe12345 qwe123qwe qweqweqwe
iloveyou iloveyou1 iloveyou123 iloveyou12 teamo teamo123
admin admin1 admin123 admin1234 admin12345 admin123456 administrator administrator1 admin@123 admin@1234 root root123 root1234 toor test test123 test1234 test12345 teste teste123 teste1234 guest guest123 user user123 default changeme changeme123 letmein letmein1 letmein123 welcome welcome1 welcome123 welcome12345 welcome2024 welcome2025 welcome2026
monkey monkey123 dragon dragon123 master master123 shadow shadow123 sunshine sunshine1 princess princess1 football football1 baseball baseball1 superman superman1 batman batman123 trustno1 whatever starwars hello hello123 hello1234 freedom freedom1 ninja ninja123 mustang access login login123 passw0rd1
secret secret123 qwertyasdf lovely lovely123 flower flower123 jordan23 michael michael1 jennifer jessica ashley daniel hunter hunter2 hunter123 buster soccer killer killer123 charlie charlie1 donald pepper cheese cookie computer computer1 internet internet1
google google123 facebook facebook1 iloveu iloveu123 samsung samsung123 pokemon pokemon123 naruto naruto123 minecraft minecraft1 liverpool arsenal chelsea barcelona manchester flamengo corinthians palmeiras santos gremio vasco brasil brasil123 brasil2024 brasil2025 brasil2026 brazil brazil123
saopaulo saopaulo123 ricardo123 marcelo123 fernando123 gabriel123 rafael123 lucas123 felipe123 bruno123 thiago123 amanda123 juliana123 camila123 mariana123 carolina123 patricia123 vanessa123
veterinaria veterinario cachorro cachorro123 gatinho gatinho123 amigos amor amor123 amor1234 deus deus123 jesus jesus123 jesuscristo familia familia123 felicidade felicidade123 mudar@123 abc@1234 abc@12345
cvg cvg123 cvg1234 cvg12345 cvg123456 cvgdiagnostics cvghospital hospital hospital123 hospital1234 clinica clinica123 vet vet123 vet1234 vet12345 veterinary hospitalvet hospitalvet123
january february march april may june july august september october november december summer winter spring autumn summer2024 summer2025 summer2026 winter2024 winter2025 winter2026 spring2025 spring2026 autumn2025
janeiro2024 janeiro2025 janeiro2026 fevereiro2025 marco2025 abril2025 maio2025 junho2025 julho2025 agosto2025 setembro2025 outubro2025 novembro2025 dezembro2025 outubro2026 novembro2026 dezembro2026
password2024 password2025 password2026 senha2024 senha2025 senha2026 admin2024 admin2025 admin2026 mudar2025 mudar2026 cvg2024 cvg2025 cvg2026 hospital2024 hospital2025 hospital2026
q1w2e3r4 q1w2e3r4t5 q1w2e3r4t5y6 qwer1234 qwer12345 qwer123456 asd123 asd12345 asd123456 asdf123456 zxc123 zxc12345 zxc123456 poiuytrewq lkjhgfdsa mnbvcxz 0987654321 1357924680 2468013579 11223344 112233445566 12341234 1234abcd 123abc123 aaaaaa aaaaaaaa bbbbbbbb
trustno1trustno1 correcthorsebatterystaple thequickbrownfox letmein123456 iloveyou123456 welcome123456 administrator123 administrator123456 changeme123456 passwordpassword password0000 passwordpassword1 mypassword mypassword1 mypassword123 myp@ssw0rd
sistema sistema123 sistema1234 usuario usuario123 usuario1234 senhaforte senhasegura senha@123 senha@1234 senha#123 senha!123 mudarsenha novasenha novasenha123 trocar123 trocarsenha
`;

export const COMMON_PASSWORDS: ReadonlySet<string> = new Set(ENTRIES.split(/\s+/).filter(Boolean));
