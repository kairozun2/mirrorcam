// Запрещаем доп. консольное окно в release-сборке на Windows
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    mirrorcam_lib::run()
}
