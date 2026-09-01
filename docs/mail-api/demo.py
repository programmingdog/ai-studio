#coding: utf-8
# +-------------------------------------------------------------------
# | 宝塔Linux面板
# +-------------------------------------------------------------------
# | Copyright (c) 2015-2099 宝塔软件(http://bt.cn) All rights reserved.
# +-------------------------------------------------------------------
# | Author: 王张杰 <750755014@qq.com>
# +-------------------------------------------------------------------

#------------------------------
# send mail api demo of Python
#------------------------------
import requests


def send_mail(mail_from, password, mail_to, subject, content, subtype=None):

    # 要调用的发件接口地址，例如http://192.168.1.11:8888/mail_sys/send_mail_http.json
    url = 'http://your_panel_address/mail_sys/send_mail_http.json'

    pdata = {}
    pdata['mail_from'] = mail_from
    pdata['password'] = password
    pdata['mail_to'] = mail_to
    pdata['subject'] = subject
    pdata['content'] = content
    pdata['subtype'] = subtype

    resp_data = requests.post(url, pdata).json()
    print(resp_data)


if __name__ == '__main__':

    # 发件人邮箱地址，例如jack@bt.cn
    mail_from = ''
    # 发件人邮箱地址密码
    password = ''
    # 收件人地址，多个用英文逗号隔开，例如 jack@bt.cn,rose@bt.cn
    mail_to = ''
    # 邮件标题
    subject = ''
    # 邮件内容
    content = ''
    # 邮件类型，不传默认为plain，要发送html请传html
    subtype = ''
    send_mail(mail_from, password, mail_to, subject, content)
